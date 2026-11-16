import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { join } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ReplController, type ReplHarness } from "../../src/cli/repl/repl-controller.ts";
import { createPromptDraft } from "../../src/cli/input/prompt-draft.ts";
import { createTextInputState } from "../../src/cli/input/text-input-state.ts";
import { McpRuntime } from "../../src/mcp/runtime.ts";
import { translate } from "../../src/cli/locale.ts";
import { tempWorkspace, waitFor } from "../support/fixtures.ts";

function fixture(t: TestContext, interactive = true) {
	let runtime: McpRuntime, repl: ReplController;
	const root = tempWorkspace(t, async () => { repl.dispose(); await runtime.close(); });
	runtime = new McpRuntime({ cwd: root, appHome: join(root, "user") });
	let prompts = 0;
	const harness: ReplHarness = { mcp: runtime, prompt: async () => { prompts++; }, abort() {}, subscribe: () => () => {}, newSession() {}, listSessions: () => [],
		resumeAt: () => false, setContextWindow() {}, contextUsage: () => ({ used: 0, window: undefined }), manualCompact: async () => "nothing-to-compact" };
	repl = new ReplController({ harness, cwd: root, interactive });
	const action = (name: string) => repl.dialogs.target.actions?.[name]?.({ type: "key", name: "enter", raw: "", ctrl: false, alt: false, shift: false, meta: false });
	const choose = (id: string) => {
		const state = repl.dialogs.getSnapshot(); assert.equal(state?.kind, "picker"); if (state?.kind !== "picker") return;
		assert.ok(state.choices.some(choice => choice.id === id), id);
		for (let i = 0; i < state.choices.length && (repl.dialogs.getSnapshot() as typeof state).choices[(repl.dialogs.getSnapshot() as typeof state).selected]?.id !== id; i++) action("dialog:next");
		action("dialog:accept");
	};
	const field = (key: string, value: string) => {
		const state = repl.dialogs.getSnapshot(); assert.equal(state?.kind, "form"); if (state?.kind !== "form") return;
		assert.ok(state.fields.some(field => field.key === key));
		for (let i = 0; i <= state.fields.length && (repl.dialogs.getSnapshot() as typeof state).fields[(repl.dialogs.getSnapshot() as typeof state).selected]?.key !== key; i++) action("dialog:next");
		action("dialog:accept"); repl.dialogs.editor.replaceState(createTextInputState(value)); action("dialog:accept");
	};
	return { repl, runtime, root, choose, field, action, prompts: () => prompts, submit: (value: string) => repl.submit(createPromptDraft(value)) };
}

test("/mcp reuses the dialog dispatcher to select scope/transport, validate, save and trust", async t => {
	const f = fixture(t); await f.submit("/mcp"); f.choose(":add");
	assert.equal(f.repl.dialogs.getSnapshot()?.title, "MCP 保存范围"); f.choose("project"); f.choose("stdio");
	f.field("id", "local"); f.field("command", "node"); f.field("args", "not-json"); f.action("dialog:save");
	assert.match(f.repl.dialogs.getSnapshot()?.error ?? "", /JSON/); assert.equal(existsSync(f.runtime.config.paths.project), false);
	f.field("args", '[]'); f.action("dialog:save"); await waitFor(() => !f.repl.getSnapshot().busy, "save configuration");
	assert.equal(f.runtime.getSnapshot().servers[0].source.scope, "project"); assert.equal(f.runtime.getSnapshot().servers[0].trusted, false);
	f.choose("trust"); f.choose("trust"); await waitFor(() => !f.repl.getSnapshot().busy, "trust configuration");
	assert.equal(f.runtime.getSnapshot().servers[0].trusted, true); assert.equal(f.prompts(), 0);
	f.choose("edit"); f.field("requestTimeoutMs", "1234"); f.action("dialog:save"); await waitFor(() => !f.repl.getSnapshot().busy, "edit configuration");
	assert.equal(f.runtime.getConfig().servers[0].config.requestTimeoutMs, 1234);
	assert.equal(existsSync(f.runtime.config.paths.user), false, "editing preserves the original scope");
	assert.equal(translate("管理 MCP 服务器与能力目录", "en"), "Manage MCP servers and catalogs");
});

test("/mcp delete previews project override restoration and secret fields remain masked", async t => {
	const f = fixture(t);
	await f.runtime.save("user", "shared", { command: "user-command" });
	await f.runtime.save("project", "shared", { command: "project-command", env: { TOKEN: "fixture-secret" } });
	await f.submit("/mcp edit shared");
	assert.doesNotMatch(JSON.stringify(f.repl.dialogs.getSnapshot()), /fixture-secret/);
	f.action("dialog:cancel"); f.choose("delete");
	assert.match(f.repl.dialogs.getSnapshot()?.description ?? "", /同名用户配置/);
	f.choose("delete"); await waitFor(() => !f.repl.getSnapshot().busy, "delete override");
	assert.equal(f.runtime.getSnapshot().servers[0].source.scope, "user");
	assert.equal(Object.keys(JSON.parse(readFileSync(f.runtime.config.paths.project, "utf8")).mcpServers).length, 0);
});

test("/mcp pipe dispatch works without a model and rejects implicit trust/login or malformed subcommands", async t => {
	const f = fixture(t, false); await f.runtime.save("project", "one", { command: "node" });
	await f.submit("/mcp list"); assert.match(f.repl.getSnapshot().entries.at(-1)?.text ?? "", /one.*untrusted/);
	for (const input of ["/mcp trust one", "/mcp login one", "/mcp add", "/mcp reconnect", "/mcp list unwanted"]) {
		await f.submit(input); assert.ok(f.repl.getSnapshot().error, input); assert.equal(f.repl.dialogs.getSnapshot(), null);
	}
	await f.submit("/mcp disable one"); assert.equal(f.runtime.getSnapshot().servers[0].enabled, false);
	await f.submit("/mcp enable one"); assert.equal(f.runtime.getSnapshot().servers[0].enabled, true);
	await f.submit("/mcp reload"); assert.equal(f.repl.getSnapshot().error, undefined); assert.equal(f.prompts(), 0);
});

test("/mcp interrupt cancels connection work and leaves the REPL usable", async t => {
	const f = fixture(t), log = join(f.root, "events.jsonl");
	await f.runtime.save("user", "one", { command: process.execPath, args: [fileURLToPath(new URL("../support/mcp-server.mjs", import.meta.url)), "silent", log] });
	const request = f.submit("/mcp reconnect one"); await waitFor(() => existsSync(log), "probe starts"); f.repl.interrupt(); await request;
	assert.equal(f.repl.getSnapshot().busy, false);
	await f.submit("/mcp list"); assert.equal(f.repl.getSnapshot().error, undefined);
	assert.equal(f.prompts(), 0);
});
