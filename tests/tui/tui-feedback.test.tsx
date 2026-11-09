import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join, resolve, dirname, basename } from "node:path";
import { tmpdir } from "node:os";
import { PassThrough, Writable } from "node:stream";
import { createElement } from "react";
import { render } from "ink";
import stringWidth from "string-width";
import { Harness } from "../../src/harness/harness.ts";
import { ByokRuntime } from "../../src/cli/byok-runtime.ts";
import { startTerminalRepl } from "../../src/cli/repl/terminal-repl.tsx";
import { ReplController } from "../../src/cli/repl/repl-controller.ts";
import { createPromptDraft } from "../../src/cli/input/prompt-draft.ts";
import { createFakeStreamFn } from "../support/fake-stream.ts";
import { CommandDialog } from "../../src/tui/commands/CommandDialog.tsx";
import { ReplScreen } from "../../src/tui/layout/ReplScreen.tsx";
import { loadByokConfig } from "../../src/config/byok.ts";
import { getAppPaths } from "../../src/storage/app-paths.ts";
import { ConfigProfiles } from "../../src/config/config-profiles.ts";
import { AssistantThinkingMessage } from "../../src/tui/messages/AssistantThinkingMessage.tsx";
import { TranscriptViewport } from "../../src/tui/layout/TranscriptViewport.tsx";
import { LocaleProvider } from "../../src/tui/locale/LocaleProvider.tsx";
import { UiLocale } from "../../src/cli/locale.ts";
import type { TerminalStreams } from "../../src/cli/ink/terminal-host.ts";
import type { HarnessEvent } from "../../src/harness/harness.ts";
class Input extends PassThrough { isTTY = true; isRaw = false; setRawMode(value: boolean) { this.isRaw = value; return this; } }
class Output extends PassThrough { isTTY = true; columns = 100; rows = 28; }
const pause = (ms = 75) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean) { for (let i = 0; i < 100 && !check(); i++) await pause(10); assert.ok(check(), "timed out"); }
function fixture(loaded = true) {
	const root = resolve(mkdtempSync(join(tmpdir(), "tui-feedback-"))), path = join(root, "byok.json");
	const raw = { version: 1, currentModel: "main", connections: { local: { api: "openai-completions", baseUrl: "http://127.0.0.1:1/v1", apiKey: "fake-secret", adapter: { thinking: { mode: "effort", levels: ["low", "medium", "high", "xhigh", "max"], off: "none" } } } },
		models: { main: { connection: "local", id: "first", name: "First", contextWindow: 262144 }, second: { connection: "local", id: "second", name: "Second", contextWindow: 131072 } } };
	if (loaded) writeFileSync(path, JSON.stringify(raw));
	const h = new Harness({ cwd: root, sessionsRoot: join(root, "sessions"), streamFn: createFakeStreamFn([{ text: "Reply" }, { text: "Second reply" }]) });
	const byok = new ByokRuntime({ cwd: root, configPath: path, env: {} }, config => h.configureModel({ model: config.model, modelRef: { configPath: config.configPath, modelKey: config.currentModel }, thinking: config.thinking, getApiKey: config.getApiKey }), () => h.settings);
	byok.reload();
	const stdin = new Input(), stdout = new Output(); let output = ""; stdout.on("data", chunk => { output += chunk.toString(); });
	const app = startTerminalRepl({ harness: h, byok, cwd: root, streams: { stdin, stdout } as unknown as TerminalStreams });
	return { root, path, raw, h, byok, stdin, stdout, app, output: () => output,
		async command(text: string) { await app.repl.submit(createPromptDraft(text)); await pause(); },
		close() { app.stop(); stdin.destroy(); stdout.destroy(); assert.equal(dirname(root), resolve(tmpdir())); assert.match(basename(root), /^tui-feedback-/); rmSync(root, { recursive: true, force: true }); } };
}
async function snapshot(element: React.ReactNode, columns = 100, rows = 28) {
	const frames: string[] = [], stdin = new PassThrough(), stdout = new Writable({ write(chunk, _enc, done) { frames.push(chunk.toString()); done(); } });
	Object.assign(stdout, { columns, rows, isTTY: false });
	const app = render(element, { stdin: stdin as any, stdout: stdout as any, debug: true, exitOnCtrlC: false, patchConsole: false });
	await pause(); const result = (frames.at(-1) ?? "").replace(/\x1b\[[0-9;]*m/g, ""); app.unmount(); app.cleanup(); stdin.destroy(); stdout.destroy(); return result;
}
test("real terminal pickers update model, effort, thinking and display with isolated modal input", async () => {
	const f = fixture();
	try {
		f.stdin.write("/model\r"); await until(() => f.app.repl.dialogs.getSnapshot()?.kind === "picker");
		f.stdin.write("unexpected text"); assert.equal(f.app.prompt.getDraft().text, "");
		f.stdin.write("\x1b[B\r"); await until(() => !f.app.repl.dialogs.getSnapshot());
		assert.equal(f.h.agent.state.model?.id, "second");
		await f.command("/effort"); f.stdin.write("\x1b[C\r"); assert.equal(f.h.settings.thinking.effort, "high");
		await f.command("/thinking"); f.stdin.write("\x1b[B\r"); assert.equal(f.h.settings.thinking.enabled, false); assert.equal(f.h.settings.thinking.effort, "high");
		await f.command("/thinking"); f.stdin.write("\x1b[A\r"); assert.equal(f.h.settings.thinking.enabled, true);
		await f.command("/thinking-display"); f.stdin.write("\x1b[B\r"); assert.equal(f.app.repl.getSnapshot().thinkingDisplay, false); assert.equal(f.h.settings.thinking.enabled, true);
		await f.command("/effort"); f.stdin.write("\x1b[C\x1b"); await pause(90); assert.equal(f.h.settings.thinking.effort, "high"); assert.equal(f.app.repl.dialogs.getSnapshot(), null);
	} finally { f.close(); }
});
test("resume picker restores real saved messages by file identity without a model configuration", async () => {
	const f = fixture();
	try {
		await f.command("saved user"); f.h.newSession();
		const noModel = new Harness({ cwd: f.root, sessionsRoot: join(f.root, "sessions"), streamFn: createFakeStreamFn([]) });
		const repl = new ReplController({ harness: noModel, cwd: f.root, interactive: true });
		try {
			await repl.submit(createPromptDraft("/resume")); const state = repl.dialogs.getSnapshot(); assert.equal(state?.kind, "picker");
			repl.dialogs.target.actions!["dialog:accept"]!({ type: "key", name: "enter" } as any);
			assert.equal(repl.dialogs.getSnapshot(), null); assert.ok(repl.getSnapshot().transcript.some(item => item.kind === "user" && item.text === "saved user"));
		} finally { repl.dispose(); }
	} finally { f.close(); }
});
test("config menu adds a usable profile through the TUI, masks the secret and edits without losing other models", async () => {
	const f = fixture(false);
	try {
		await f.command("/config"); f.stdin.write("\r"); assert.equal(f.app.repl.dialogs.getSnapshot()?.kind, "form");
		const fields = ["new", "http://127.0.0.1:1/v1", "new-secret", "new-model", "Friendly"];
		for (const value of fields) { f.stdin.write("\r"); assert.equal(f.app.repl.dialogs.getSnapshot()?.kind, "field"); f.app.repl.dialogs.editor.replaceText(value); f.stdin.write("\r\t"); }
		const frame = await snapshot(createElement(CommandDialog, { controller: f.app.repl.dialogs, columns: 80, rows: 26 }), 80);
		assert.doesNotMatch(frame, /new-secret/); assert.match(frame, /••••••••/);
		f.stdin.write("\x13"); assert.equal(f.app.repl.dialogs.getSnapshot(), null);
		const path = join(getAppPaths({ cwd: f.root }).configsDir, "new.json"); assert.ok(existsSync(path)); assert.equal(loadByokConfig({ configPath: path }).model.id, "new-model"); assert.equal(f.h.agent.state.model?.id, "new-model");
		// Edit an existing multi-model file with a shared connection and preserve the other model's key.
		writeFileSync(f.path, JSON.stringify(f.raw)); const edit = f.byok.profiles.read(f.path, "main"), values = Object.fromEntries(f.byok.profiles.fields(edit).map(field => [field.key, field.value]));
		values.modelId = "edited"; values.apiKey = "replacement-secret"; f.byok.saveProfile(values, edit);
		const loaded = loadByokConfig({ configPath: f.path }); assert.equal(loaded.models.main!.id, "edited"); assert.equal(loaded.models.second!.id, "second"); assert.equal(loaded.getApiKey("second"), "fake-secret"); assert.equal(loaded.getApiKey("main"), "replacement-secret");
	} finally { f.close(); }
});
test("profile validation, collisions, concurrent edits and failed application preserve files and the active model", () => {
	const f = fixture();
	try {
		const edit = f.byok.profiles.read(f.path), values = Object.fromEntries(f.byok.profiles.fields(edit).map(field => [field.key, field.value]));
		const previous = readFileSync(f.path, "utf8");
		const invalidChanges: Record<string, string>[] = [{ fileName: "../escape" }, { contextWindow: "-1" }, { baseUrl: "bad" }, { maxOutputTokens: "999999999" }];
		for (const change of invalidChanges) assert.throws(() => f.byok.saveProfile({ ...values, ...change }, edit));
		assert.equal(readFileSync(f.path, "utf8"), previous); assert.equal(f.h.agent.state.model?.id, "first");
		writeFileSync(f.path, previous + "\n"); assert.throws(() => f.byok.saveProfile(values, edit), /其他程序修改/); writeFileSync(f.path, previous);
		const rejected = new ByokRuntime({ cwd: f.root, configPath: f.path }, () => { throw new Error("application rejected"); });
		assert.throws(() => rejected.saveProfile({ ...values, modelId: "rejected" }, rejected.profiles.read(f.path)), /application rejected/); assert.equal(readFileSync(f.path, "utf8"), previous);
		f.byok.saveProfile({ ...values, fileName: "collision", apiKey: "x" });
		assert.throws(() => f.byok.profiles.prepare({ ...values, fileName: "collision", apiKey: "x" }), /同名/);
	} finally { f.close(); }
});
test("long thinking remains contiguous through streaming, completion, scroll and full/half-screen resizing", async () => {
	const f = fixture();
	try {
		let listener!: (event: HarnessEvent) => void;
		const repl = new ReplController({ harness: { prompt: async () => {}, abort() {}, subscribe(fn) { listener = event => { void fn(event, new AbortController().signal); }; return () => {}; }, newSession() {}, listSessions: () => [], resumeAt: () => false, setContextWindow() {}, manualCompact: async () => "nothing-to-compact" as const, contextUsage: () => ({ used: 0, window: undefined }) }, interactive: true });
		const message: any = { role: "assistant", content: [], model: "fake", stopReason: "stop", timestamp: 0 };
		listener({ type: "message_start", message });
		let text = "";
		for (let part = 0; part < 4; part++) {
			const delta = Array.from({ length: 30 }, (_, i) => `Thinking line ${part * 30 + i}: continuous content.\n`).join(""); text += delta;
			listener({ type: "message_update", message, assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta, partial: message } } as any);
			for (const columns of [100, 45, 100]) {
				const element = createElement(ReplScreen, { repl, prompt: f.app.prompt, suggestions: f.app.suggestions, cwd: f.root, columns, rows: 28 });
				const frame = await snapshot(element, columns);
				assert.match(frame, new RegExp(`Thinking line ${part * 30 + 29}`));
				const body = frame.split("\n").filter(line => line.includes("Thinking line")); assert.ok(body.length >= 8, `viewport contains only ${body.length} lines`);
				assert.ok(frame.split("\n").length <= 28); for (const line of frame.split("\n")) assert.ok(stringWidth(line) <= columns);
			}
		}
		listener({ type: "message_end", message: { ...message, content: [{ type: "thinking", thinking: text }] } });
		repl.scroll(10000); const frame = await snapshot(createElement(ReplScreen, { repl, prompt: f.app.prompt, suggestions: f.app.suggestions, cwd: f.root, columns: 100, rows: 28 })); assert.match(frame, /Thinking line 0/);
		assert.equal(repl.getSnapshot().activeItems.filter(item => item.kind === "assistant")[0]?.blocks[0]?.text, text); repl.dispose();
	} finally { f.close(); }
});

test("same Ink instance keeps long thinking visible while repeatedly resizing during streaming", async () => {
	const frames: string[] = [], stdin = new PassThrough(), stdout = new Writable({ write(chunk, _enc, done) { frames.push(chunk.toString()); done(); } });
	Object.assign(stdout, { columns: 120, rows: 30, isTTY: false });
	let text = "";
	const tree = (columns: number) => createElement(TranscriptViewport, { height: 24, columns, scrollOffset: 0, items: [{ id: 1, kind: "assistant", timestamp: 0, blocks: [{ kind: "thinking", index: 0, text }] }], header: null, headerKey: "", expanded: true, thinkingDisplay: true, onMetrics() {} });
	const app = render(tree(119), { stdin: stdin as any, stdout: stdout as any, debug: true, exitOnCtrlC: false, patchConsole: false });
	try {
		for (const columns of [119, 59, 119, 44, 79, 119]) {
			for (let i = 0; i < 35; i++) text += `Thinking line ${text.length}: Checking terminal layout and continuity.\n`;
			Object.assign(stdout, { columns: columns + 1 }); stdout.emit("resize"); app.rerender(tree(columns)); await pause();
			const frame = (frames.at(-1) ?? "").replace(/\x1b\[[0-9;]*m/g, "");
			assert.ok(frame.split("\n").filter(line => line.includes("Thinking line")).length >= 10, frame);
			for (const line of frame.split("\n")) assert.ok(stringWidth(line) <= columns);
		}
	} finally { app.unmount(); app.cleanup(); stdin.destroy(); stdout.destroy(); }
});

test("model management adds to the same configuration and field pages cancel independently", async () => {
	const f = fixture();
	try {
		const original = readFileSync(f.path, "utf8");
		await f.command("/config"); f.stdin.write("\x1b[A\r\r");
		assert.equal(f.app.repl.dialogs.getSnapshot()?.title, "管理模型"); f.stdin.write("\x1b[A\r");
		assert.equal(f.app.repl.dialogs.getSnapshot()?.title, "新增模型");
		// Nothing is written while editing a field, and Esc only cancels that field.
		f.stdin.write("\x1b[B\r"); assert.equal(f.app.repl.dialogs.getSnapshot()?.kind, "field");
		f.app.repl.dialogs.editor.replaceText("http://discarded.invalid"); f.stdin.write("\x1b"); await pause();
		let form = f.app.repl.dialogs.getSnapshot(); assert.equal(form?.kind, "form"); if (form?.kind !== "form") throw new Error("form missing");
		assert.equal(form.fields[1]!.value, "http://127.0.0.1:1/v1"); assert.equal(readFileSync(f.path, "utf8"), original);
		f.stdin.write("\x13"); assert.match(f.app.repl.dialogs.getSnapshot()?.error ?? "", /模型 ID/);
		assert.equal(readFileSync(f.path, "utf8"), original);
		f.stdin.write("\x1b[B\x1b[B\r"); f.app.repl.dialogs.editor.replaceText("third-model"); f.stdin.write("\r\x13");
		assert.equal(f.app.repl.dialogs.getSnapshot(), null);
		const loaded = loadByokConfig({ configPath: f.path });
		assert.equal(Object.keys(loaded.models).length, 3); assert.equal(loaded.models.main!.id, "first"); assert.equal(loaded.models.second!.id, "second");
		assert.equal(loaded.model.id, "third-model"); assert.equal(loaded.getApiKey(), "fake-secret"); assert.equal(f.h.agent.state.model?.id, "third-model");
		await f.command("/model"); const picker = f.app.repl.dialogs.getSnapshot(); assert.equal(picker?.kind, "picker");
		if (picker?.kind !== "picker") throw new Error("picker missing"); assert.ok(picker.choices.some(item => item.label === "third-model" && item.current));
		assert.doesNotMatch(f.output(), /fake-secret/);
	} finally { f.close(); }
});

test("language switches all command/configuration screens, persists locally and preserves model/user content", async () => {
	const f = fixture();
	const view = () => snapshot(createElement(LocaleProvider, { locale: f.app.repl.locale, children: createElement(ReplScreen, { repl: f.app.repl, prompt: f.app.prompt, suggestions: f.app.suggestions, cwd: f.root, columns: 100, rows: 28 }) }));
	try {
		await f.command("/language"); f.stdin.write("\x1b[B\r");
		assert.equal(f.app.repl.locale.getSnapshot(), "en"); assert.equal(new UiLocale(f.root).getSnapshot(), "en");
		assert.equal(f.h.agent.state.model?.id, "first");
		for (const command of ["/model", "/effort", "/thinking", "/thinking-display", "/config"]) {
			await f.command(command); assert.doesNotMatch(await view(), /[\u4e00-\u9fff]/); f.app.repl.dialogs.cancel();
		}
		await f.command("/config"); f.stdin.write("\x1b[A\r\r\r"); // edit file → models → first model's field list
		assert.match(await view(), /Model ID|Context window/); assert.doesNotMatch(await view(), /[\u4e00-\u9fff]/);
		f.stdin.write("\x1b[B\r"); assert.match(await view(), /API URL/);
		f.app.repl.dialogs.editor.replaceText("invalid-url"); f.stdin.write("\r\x13"); assert.match(await view(), /absolute HTTP/); assert.doesNotMatch(await view(), /[\u4e00-\u9fff]/);
		f.app.repl.dialogs.close(); await f.command("/help"); assert.doesNotMatch(await view(), /[\u4e00-\u9fff]/);
		await f.command("保持用户原文"); assert.ok(f.h.agent.state.messages.some(message => message.role === "user" && message.content.some(block => block.type === "text" && block.text === "保持用户原文")));
		await f.command("/language"); f.stdin.write("\x1b[A\r"); assert.equal(f.app.repl.locale.getSnapshot(), "zh");
		assert.match(await view(), /输入 \/ 查看命令/);
	} finally { f.close(); }
});

test("scrollback mode uses the main screen and keeps the footer minimal", async () => {
	const f = fixture();
	try {
		await f.command("hello"); assert.doesNotMatch(f.output(), /\x1b\[\?1049[hl]|\x1b\[3J/);
		const frame = await snapshot(createElement(ReplScreen, { repl: f.app.repl, prompt: f.app.prompt, suggestions: f.app.suggestions, cwd: f.root, columns: 100, rows: 28 }));
		const footer = frame.trimEnd().split("\n").at(-1)!; assert.match(footer, /^default · Shift\+Tab 切换$/); assert.doesNotMatch(footer, /权限|Ctrl\+O|PgUp/);
	} finally { f.close(); }
});

test("keyboard history remains anchored while additional thinking arrives", async () => {
	const f = fixture(); let listener!: (event: HarnessEvent) => void;
	const repl = new ReplController({ harness: { prompt: async () => {}, abort() {}, subscribe(fn) { listener = event => { void fn(event, new AbortController().signal); }; return () => {}; }, newSession() {}, listSessions: () => [], resumeAt: () => false, setContextWindow() {}, manualCompact: async () => "nothing-to-compact" as const, contextUsage: () => ({ used: 0, window: undefined }) }, interactive: true });
	const frames: string[] = [], stdin = new PassThrough(), stdout = new Writable({ write(chunk, _enc, done) { frames.push(chunk.toString()); done(); } });
	Object.assign(stdout, { columns: 100, rows: 28, isTTY: false });
	const app = render(createElement(ReplScreen, { repl, prompt: f.app.prompt, suggestions: f.app.suggestions, cwd: f.root, columns: 100, rows: 28 }), { stdin: stdin as any, stdout: stdout as any, debug: true, patchConsole: false, exitOnCtrlC: false });
	const message: any = { role: "assistant", content: [], model: "fake", stopReason: "stop", timestamp: 0 };
	const emit = (delta: string) => listener({ type: "message_update", message, assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta, partial: message } } as any);
	const visible = () => (frames.at(-1) ?? "").replace(/\x1b\[[0-9;]*m/g, "").split("\n").filter(line => line.includes("Thinking line"));
	try {
		listener({ type: "message_start", message }); emit(Array.from({ length: 80 }, (_, i) => `Thinking line ${i}: content.\n`).join("")); await pause();
		repl.scroll(15); await pause(); const before = visible(); assert.ok(before.length);
		emit(Array.from({ length: 15 }, (_, i) => `Thinking line ${80+i}: new content.\n`).join("")); await pause(); assert.deepEqual(visible(), before);
		repl.scroll(-10000); await pause(); assert.match(visible().join("\n"), /Thinking line 94/);
	} finally { app.unmount(); app.cleanup(); repl.dispose(); stdin.destroy(); stdout.destroy(); f.close(); }
});
