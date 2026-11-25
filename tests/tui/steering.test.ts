import assert from "node:assert/strict";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import type { TerminalStreams } from "../../src/cli/ink/terminal-host.ts";
import { startTerminalRepl } from "../../src/cli/repl/terminal-repl.tsx";
import { Harness } from "../../src/harness/harness.ts";
import { UiLocale } from "../../src/cli/locale.ts";
import { getAppPaths } from "../../src/storage/app-paths.ts";
import { createScriptedModel } from "../support/scripted-model.ts";
import { deferred, tempWorkspace, waitFor } from "../support/fixtures.ts";
import { messageText, testModel } from "../support/harness.ts";
import { TerminalScreen } from "../support/terminal-screen.ts";

function terminal(harness: Harness, cwd: string) {
	const stdin = Object.assign(new PassThrough(), { isTTY: true, isRaw: false, setRawMode(raw: boolean) { this.isRaw = raw; } });
	const stdout = Object.assign(new PassThrough(), { isTTY: true, columns: 110, rows: 32 });
	const screen = new TerminalScreen(stdout.columns, stdout.rows);
	stdout.on("data", chunk => screen.write(chunk.toString()));
	const locale = new UiLocale(cwd, false, getAppPaths({ cwd, appHome: join(cwd, "app") }));
	const app = startTerminalRepl({ harness, cwd, locale, permissionMode: "yolo", streams: { stdin, stdout } as unknown as TerminalStreams });
	return { app, screen, send(text: string) { stdin.write(text); stdin.write("\r"); },
		async close() { app.stop(); await app.done; await harness.close(); stdin.destroy(); stdout.destroy(); screen.dispose(); } };
}

test("a busy session in the resume picker reports the conflict and accepts the next prompt", { timeout: 15000 }, async t => {
	const cwd = tempWorkspace(t), options = { cwd, appHome: join(cwd, "app"), model: testModel, apiKey: "local" };
	const parent = createScriptedModel([
		{ toolCalls: [{ id: "start", name: "agent_task", arguments: { action: "start", prompt: "delegated work" } }] },
		{ text: "delegated" },
	]);
	const child = createScriptedModel([{ text: "done" }]);
	const owner = new Harness({ ...options, streamFn: (model, context, settings) =>
		(context.tools?.some(tool => tool.name === "agent_task") ? parent : child).streamFn(model, context, settings) });
	const other = createScriptedModel([{ text: "accepted next prompt" }]);
	const ui = terminal(new Harness({ ...options, streamFn: other.streamFn }), cwd);
	try {
		await owner.prompt("start a task");
		ui.send("/resume");
		await waitFor(() => ui.app.repl.dialogs.getSnapshot()?.kind === "picker", "session picker");
		ui.send("");
		await waitFor(() => ui.app.repl.getSnapshot().entries.some(entry => entry.text.includes("Another active session")), "ownership error");
		assert.equal(ui.app.repl.getSnapshot().resumeChoices, null);
		ui.send("continue here");
		await waitFor(() => other.requests.length === 1, "next model request");
		assert.equal(messageText(other.requests[0]!.context.messages.at(-1)), "continue here");
	} finally { await ui.close(); await owner.close(); }
});

test("Enter queues successive busy drafts while the current tool batch stays active", { timeout: 15000 }, async t => {
	const cwd = tempWorkspace(t), entered = deferred(), release = deferred();
	const model = createScriptedModel([
		{ toolCalls: ["a", "b"].map(id => ({ id, name: "read", arguments: { path: "missing.txt" } })) },
		{ text: "processed both instructions" },
	]);
	const harness = new Harness({ cwd, appHome: join(cwd, "app"), model: testModel, apiKey: "local", streamFn: model.streamFn });
	harness.setBeforeToolCall(async ({ toolCall }) => {
		if (toolCall.id === "a") { entered.resolve(); await release.promise; }
		return undefined;
	});
	const ui = terminal(harness, cwd);
	try {
		ui.send("read two files");
		await entered.promise;
		await waitFor(() => /^ *> █$/m.test(ui.screen.text) && ui.app.repl.getSnapshot().acceptsSteering, "focused busy prompt");
		for (const text of ["暂停 A", "也检查配置"]) {
			ui.send(text);
			assert.equal(ui.app.prompt.getDraft().text, "");
			assert.ok(ui.app.repl.getSnapshot().busy);
			assert.equal(ui.app.repl.getSnapshot().entries.filter(entry => entry.text === `> ${text}`).length, 1);
		}
		assert.equal(model.requests.length, 1);
		release.resolve();
		await waitFor(() => !ui.app.repl.getSnapshot().busy, "completion");
		const tail = model.requests[1]!.context.messages.slice(-4);
		assert.deepEqual(tail.map(m => m.role === "toolResult" ? m.toolCallId : messageText(m)), ["a", "b", "暂停 A", "也检查配置"]);
	} finally { release.resolve(); await ui.close(); }
});

test("Enter during wait returns interrupted before the model acts on the pause instruction", { timeout: 15000 }, async t => {
	const cwd = tempWorkspace(t), waiting = deferred(), childEntered = deferred(), childRelease = deferred();
	const sawSteer = deferred(), allowPause = deferred();
	let agentId = "";
	const parent = createScriptedModel([
		{ toolCalls: [{ id: "start", name: "agent_task", arguments: { action: "start", prompt: "Child A" } }] },
		({ context }) => {
			agentId = JSON.parse(messageText(context.messages.at(-1))).agent_id;
			return { toolCalls: [{ id: "wait", name: "wait_agent", arguments: { agent_id: agentId } }] };
		},
		async () => {
			sawSteer.resolve(); await allowPause.promise;
			return { toolCalls: [{ id: "pause", name: "agent_task", arguments: { agent_id: agentId, action: "pause" } }] };
		},
		{ text: "A 已暂停" },
	]);
	const child = createScriptedModel([async ({ options }) => {
		options?.signal?.addEventListener("abort", () => childRelease.resolve(), { once: true });
		childEntered.resolve(); await childRelease.promise;
		return { text: "finished" };
	}]);
	const harness = new Harness({ cwd, appHome: join(cwd, "app"), model: testModel, apiKey: "local",
		streamFn: (model, context, options) => (context.tools?.some(tool => tool.name === "agent_task") ? parent : child).streamFn(model, context, options) });
	harness.subscribe(event => { if (event.type === "tool_execution_start" && event.toolCallId === "wait") waiting.resolve(); });
	const ui = terminal(harness, cwd);
	try {
		ui.send("delegate and wait"); await Promise.all([waiting.promise, childEntered.promise]);
		await waitFor(() => ui.screen.text.includes("wait_agent") && /^ *> █$/m.test(ui.screen.text), "pending wait and draft editor");
		ui.send("暂停 A");
		await sawSteer.promise;
		const messages = parent.requests[2]!.context.messages;
		const wait = messages.at(-2)!;
		assert.equal(wait.role, "toolResult");
		assert.ok(wait.role === "toolResult" && wait.toolCallId === "wait");
		assert.deepEqual(JSON.parse(messageText(wait)), { agent_id: agentId, status: "interrupted" });
		assert.equal(messageText(messages.at(-1)), "暂停 A");
		assert.equal(messages.at(-1)!.role, "user");
		assert.equal(child.requests[0]!.options!.signal!.aborted, false);
		allowPause.resolve();
		await waitFor(() => !ui.app.repl.getSnapshot().busy, "parent ended after pause");
		const paused = parent.requests[3]!.context.messages.at(-1)!;
		assert.ok(paused.role === "toolResult" && paused.toolCallId === "pause");
		assert.deepEqual(JSON.parse(messageText(paused)), { agent_id: agentId, status: "paused" });
		assert.equal(ui.app.repl.getSnapshot().entries.filter(entry => entry.text === "> 暂停 A").length, 1);
	} finally { allowPause.resolve(); childRelease.resolve(); await ui.close(); }
});
