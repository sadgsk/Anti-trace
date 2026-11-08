import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname, basename } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { createElement } from "react";
import { render } from "ink";
import stringWidth from "string-width";
import { Harness } from "../../src/harness/harness.ts";
import { ReplController } from "../../src/cli/repl/repl-controller.ts";
import { createPromptDraft } from "../../src/cli/input/prompt-draft.ts";
import { PromptInputController } from "../../src/cli/input/prompt-input-controller.ts";
import { PromptSuggestionsController } from "../../src/tui/suggestions/prompt-suggestions-controller.ts";
import { startTerminalRepl } from "../../src/cli/repl/terminal-repl.tsx";
import { PermissionPolicy } from "../../src/cli/permissions/permission-policy.ts";
import { PermissionDialog } from "../../src/tui/permissions/PermissionDialog.tsx";
import { WorkspaceFileIndex, fileSuggestionQuery } from "../../src/tui/suggestions/file-index.ts";
import { createEditTool } from "../../src/harness/tools/edit.ts";
import { createWriteTool } from "../../src/harness/tools/write.ts";
import { createBashTool } from "../../src/harness/tools/bash.ts";
import { Markdown } from "../../src/tui/markdown/Markdown.tsx";
import { StructuredDiff } from "../../src/tui/diff/StructuredDiff.tsx";
import { WelcomeHeader } from "../../src/tui/layout/WelcomeHeader.tsx";
import { buildDiff } from "../../src/harness/tools/diff.ts";
import { detectColorDepth, resolveTheme } from "../../src/tui/theme/color.ts";
import { FocusStack } from "../../src/tui/focus/focus-stack.tsx";
import { FocusStackProvider } from "../../src/tui/focus/focus-stack.tsx";
import { Select } from "../../src/tui/design-system/Select.tsx";
import { createSessionFile, appendEntry } from "../../src/harness/session.ts";
import { InputDispatcher } from "../../src/cli/input/input-dispatcher.ts";
import { REPL_KEYBINDINGS } from "../../src/cli/input/keybindings.ts";
import type { BeforeToolCallContext, Model } from "../../src/types.ts";
import type { TerminalStreams } from "../../src/cli/ink/terminal-host.ts";
import { createFakeStreamFn, type FakeStreamTurn } from "../support/fake-stream.ts";
const pause = (ms = 70) => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate: () => boolean) { for (let i = 0; i < 100 && !predicate(); i++) await pause(15); assert.ok(predicate(), "condition timed out"); }
async function fixture() {
	const root = resolve(await mkdtemp(join(tmpdir(), "tui-full-")));
	return { root, cleanup: async () => { assert.equal(dirname(root), resolve(tmpdir())); assert.ok(basename(root).startsWith("tui-full-")); await rm(root, { recursive: true, force: true }); } };
}
const model: Model = { id: "fake", name: "TUI local test", provider: "fake", baseUrl: "http://127.0.0.1:1", api: "openai-completions", contextWindow: 100000 };
function harness(root: string, turns: FakeStreamTurn[]) { return new Harness({ cwd: root, sessionsRoot: join(root, "sessions"), model, apiKey: "fake", streamFn: createFakeStreamFn(turns) }); }
function context(name: string, args: Record<string, unknown>): BeforeToolCallContext {
	return { toolCall: { type: "toolCall", id: "call", name, arguments: args }, args,
		assistantMessage: { role: "assistant", content: [], model: "fake", stopReason: "toolUse", timestamp: 0 }, context: { systemPrompt: "", messages: [] } };
}
class Input extends PassThrough { isTTY = true; isRaw = false; setRawMode(value: boolean) { this.isRaw = value; return this; } }
class Output extends PassThrough { isTTY = true; columns = 100; rows = 28; }
async function terminalFixture(turns: FakeStreamTurn[]) {
	const f = await fixture(), h = harness(f.root, turns), stdin = new Input(), stdout = new Output(); let output = "";
	stdout.on("data", chunk => { output += chunk.toString(); });
	const app = startTerminalRepl({ harness: h, cwd: f.root, streams: { stdin, stdout } as unknown as TerminalStreams });
	return { ...f, h, app, stdin, stdout, output: () => output, close: async () => { app.stop(); stdin.destroy(); stdout.destroy(); await f.cleanup(); } };
}

test("tool details expose real write/create and edit hunks while content remains compatible", async () => {
	const f = await fixture();
	try {
		const write = createWriteTool(f.root);
		const created = await write.execute("1", { path: "a.ts", content: "const a = 1;\n" });
		assert.equal(created.details.created, true); assert.match(created.content[0]!.type === "text" ? created.content[0].text : "", /Successfully wrote/);
		const edited = await createEditTool(f.root).execute("2", { path: "a.ts", edits: [{ oldText: "a = 1", newText: "a = 2" }] });
		assert.equal(edited.details.addedLines, 1); assert.equal(edited.details.removedLines, 1);
		assert.ok(edited.details.hunks[0]!.lines.some(line => line.includes("a = 2")));
		const overwritten = await write.execute("3", { path: "a.ts", content: "const b = 3;\n" });
		assert.equal(overwritten.details.created, false); assert.ok(overwritten.details.hunks?.length);
	} finally { await f.cleanup(); }
});

test("Bash delivers throttled live output and final duration/exit details", async () => {
	const f = await fixture(), updates: unknown[] = [];
	try {
		const command = `"${process.execPath}" -e "console.log('first');setTimeout(()=>console.log('second'),180)"`;
		const result = await createBashTool(f.root).execute("b", { command }, undefined, update => updates.push(update));
		assert.ok(updates.length); assert.equal(result.details.exitCode, 0); assert.ok(result.details.durationMs! >= 180);
		assert.match(result.content[0]!.type === "text" ? result.content[0].text : "", /first[\s\S]*second/);
	} finally { await f.cleanup(); }
});

test("permission modes, exact command memory, session reset and noninteractive denial", async () => {
	const f = await fixture(), p = new PermissionPolicy(f.root, true);
	try {
		assert.equal(await p.beforeToolCall(context("read", { path: "a" })), undefined);
		const pending = p.beforeToolCall(context("bash", { command: "echo one" }));
		await until(() => Boolean(p.getSnapshot().request)); p.decide("session"); assert.equal(await pending, undefined);
		assert.equal(await p.beforeToolCall(context("bash", { command: "echo one" })), undefined);
		const different = p.beforeToolCall(context("bash", { command: "echo one && echo two" }));
		await until(() => Boolean(p.getSnapshot().request)); p.decide("deny"); assert.equal((await different)?.block, true);
		p.resetSession(); const again = p.beforeToolCall(context("bash", { command: "echo one" }));
		await until(() => Boolean(p.getSnapshot().request)); p.cycleMode(); p.cycleMode(); assert.equal(await again, undefined);
		const pipe = new PermissionPolicy(f.root, false); assert.equal((await pipe.beforeToolCall(context("bash", { command: "echo one" })))?.block, true); pipe.dispose();
	} finally { p.dispose(); await f.cleanup(); }
});

test("denial feedback and abortion settle the permission promise and remove the modal", async () => {
	const f = await fixture(), p = new PermissionPolicy(f.root, true);
	try {
		const pending = p.beforeToolCall(context("bash", { command: "echo one" }));
		await until(() => Boolean(p.getSnapshot().request)); p.move(-1); p.accept();
		assert.equal(p.getSnapshot().editingFeedback, true); p.feedback.insertText("please use read"); p.accept();
		assert.equal((await pending)?.reason, "please use read"); assert.equal(p.getSnapshot().request, null);
		const controller = new AbortController(), next = p.beforeToolCall(context("bash", { command: "echo two" }), controller.signal);
		await until(() => Boolean(p.getSnapshot().request)); controller.abort(); assert.equal((await next)?.block, true); assert.equal(p.getSnapshot().request, null);
	} finally { p.dispose(); await f.cleanup(); }
});

test("actual terminal approves an edit before mutation, commits structured tools and renders Markdown", async () => {
	const f = await terminalFixture([{ toolCalls: [{ id: "edit1", name: "edit", arguments: { path: "a.ts", edits: [{ oldText: "one", newText: "two" }] } }] }, { text: "## Done\n\n**Updated** `a.ts`.\n\n| a | b |\n|---|---|\n| 1 | 2 |" }]);
	try {
		await writeFile(join(f.root, "a.ts"), "one\n");
		f.stdin.write("edit file\r"); await until(() => Boolean(f.app.repl.permissions.getSnapshot().request));
		assert.equal(await readFile(join(f.root, "a.ts"), "utf8"), "one\n");
		assert.equal(f.stdin.listenerCount("data"), 1); f.stdin.write("1");
		await until(() => !f.app.repl.getSnapshot().busy); await pause();
		assert.equal(await readFile(join(f.root, "a.ts"), "utf8"), "two\n");
		assert.ok(f.app.repl.getSnapshot().transcript.some(item => item.kind === "tool" && item.status === "success" && item.result?.details));
		assert.match(f.output(), /Done/); assert.match(f.output(), /Updated/);
		f.stdin.write("\x0f"); await pause(); assert.equal(f.app.repl.getSnapshot().expanded, true); assert.doesNotMatch(f.output(), /\x1b\[2J/);
		assert.equal(f.stdin.listenerCount("data"), 1);
	} finally { await f.close(); }
});

test("interrupting an approval pairs every pending tool call and never mutates files", async () => {
	const f = await terminalFixture([{ toolCalls: ["c1", "c2"].map(id => ({ id, name: "write", arguments: { path: `${id}.txt`, content: "blocked" } })) }]);
	try {
		f.stdin.write("write files\r"); await until(() => Boolean(f.app.repl.permissions.getSnapshot().request)); f.stdin.write("\x03");
		await until(() => !f.app.repl.getSnapshot().busy);
		const results = f.h.agent.state.messages.filter(message => message.role === "toolResult");
		assert.deepEqual(results.map(message => message.toolCallId), ["c1", "c2"]);
		assert.ok(results.every(message => message.isError)); assert.equal(f.app.repl.permissions.getSnapshot().request, null);
		await assert.rejects(readFile(join(f.root, "c1.txt"))); await assert.rejects(readFile(join(f.root, "c2.txt")));
		f.stdin.write("/new\r"); await until(() => !f.app.repl.getSnapshot().busy);
		assert.equal(f.app.repl.getSnapshot().transcript.some(item => item.kind === "tool"), false);
	} finally { await f.close(); }
});

test("workspace file indexing excludes generated directories and handles fuzzy matching", async () => {
	const f = await fixture();
	try {
		await mkdir(join(f.root, "src")); await mkdir(join(f.root, "node_modules"));
		await writeFile(join(f.root, "src", "main.ts"), ""); await writeFile(join(f.root, "src", "my file.ts"), ""); await writeFile(join(f.root, "node_modules", "hidden.ts"), "");
		const index = new WorkspaceFileIndex(f.root);
		assert.equal((await index.search("smts"))[0], "src/main.ts"); assert.equal((await index.search("hidden")).length, 0);
		assert.equal(fileSuggestionQuery(createPromptDraft("read @src/ma"))?.query, "src/ma");
		const h = harness(f.root, []), repl = new ReplController({ harness: h }), prompt = new PromptInputController({ availableColumns: 60 });
		const menu = new PromptSuggestionsController(prompt, repl, { cwd: f.root });
		try {
			prompt.textInput.insertText("read @src/my"); await until(() => menu.getSnapshot().items.length > 0);
			menu.target.actions?.["suggestions:accept"]?.({ type: "key", name: "enter", raw: "", ctrl: false, alt: false, shift: false, meta: false });
			assert.equal(prompt.getDraft().text, 'read @"src/my file.ts" '); assert.equal(menu.getSnapshot().open, false);
			prompt.handleAction("input:undo"); assert.equal(prompt.getDraft().text, "read @src/my");
		} finally { menu.dispose(); prompt.dispose(); repl.dispose(); }
	} finally { await f.cleanup(); }
});

test("modal focus intercepts prompt editing while keeping global interruption reachable", () => {
	const dispatcher = new InputDispatcher(), focus = new FocusStack(dispatcher, REPL_KEYBINDINGS), calls: string[] = [];
	focus.set("editor", { id: Symbol(), context: "Input", onInput: () => { calls.push("editor"); } });
	focus.set("global", { id: Symbol(), context: "Global", actions: { "app:interrupt": () => { calls.push("interrupt"); } } });
	focus.set("modal", { id: Symbol(), context: "Permission", onInput: () => { calls.push("modal"); } });
	dispatcher.dispatch({ type: "text", text: "x" });
	dispatcher.dispatch({ type: "key", name: "c", raw: "", ctrl: true, alt: false, shift: false, meta: false });
	assert.deepEqual(calls, ["modal", "interrupt"]);
});

class Capture extends Writable { isTTY = false; columns = 100; rows = 40; frames: string[] = []; _write(chunk: Buffer, _encoding: string, next: () => void) { this.frames.push(chunk.toString()); next(); } }
async function snapshot(element: ReturnType<typeof createElement>, columns = 100) {
	const stdout = new Capture(); stdout.columns = columns; const stdin = new PassThrough();
	const app = render(element, { stdout: stdout as unknown as NodeJS.WriteStream, stdin: stdin as unknown as NodeJS.ReadStream, debug: true, patchConsole: false, exitOnCtrlC: false });
	try { await pause(); return stdout.frames.at(-1) ?? ""; } finally { app.unmount(); app.cleanup(); stdin.destroy(); stdout.destroy(); }
}
test("Markdown renders nested blocks, highlighted code, tables and safe external text", async () => {
	const frame = await snapshot(createElement(Markdown, { text: '# Heading\n\n- **bold**\n  - nested\n\n> quote\n\n```ts\nconst a = 1;\n```\n\n| name | result |\n|---|---|\n| 中文 | yes |\n\n\x1b]52;bad\x07', columns: 60 }));
	for (const text of ["Heading", "nested", "quote", "const a = 1", "中文", "yes"]) assert.ok(frame.includes(text), text);
	assert.ok(frame.includes("┌")); assert.ok(!frame.includes("\x1b]52"));
	const narrow = await snapshot(createElement(Markdown, { text: '| a | b |\n|---|---|\n| alpha | beta |', columns: 12 }), 12);
	assert.match(narrow, /alpha/); assert.match(narrow, /beta/);
});

test("Diff renders actual line numbers, additions/deletions and collapse information", async () => {
	const diff = buildDiff("a.ts", "const a = 1;\nold\n", "const a = 2;\nnew\n");
	const frame = await snapshot(createElement(StructuredDiff, { hunks: diff.hunks, columns: 50 }));
	assert.match(frame, /- const a = 1/); assert.match(frame, /\+ const a = 2/);
	const short = await snapshot(createElement(StructuredDiff, { hunks: diff.hunks, columns: 50, maxLines: 1 })); assert.match(short, /Ctrl\+O/);
});

test("welcome keeps identical logo geometry on narrow and wide terminals, color depth honors explicit settings", async () => {
	const display = { modelName: "Test model", thinking: { enabled: false, effort: "medium" as const }, contextUsed: 0, contextWindow: 128000, sessionTitle: "New" };
	const narrow = await snapshot(createElement(WelcomeHeader, { cwd: "demo", display, columns: 60, rows: 24, permissionMode: "default" }), 60);
	assert.match(narrow, /Test model · 0 \/ 128k · medium/); assert.doesNotMatch(narrow, /ctx|thinking/);
	const wide = await snapshot(createElement(WelcomeHeader, { cwd: "demo", display, columns: 120, rows: 24, permissionMode: "yolo" }), 120);
	assert.match(narrow.split("\n")[0]!, /^▄██▄  █▄ █╗ ████╗/);
	assert.deepEqual(narrow.split("\n").slice(0, 6), wide.split("\n").slice(0, 6));
	assert.ok(narrow.split("\n").slice(0, 6).every(line => stringWidth(line) <= 54));
	assert.equal(detectColorDepth({ isTTY: true } as NodeJS.WriteStream, { NO_COLOR: "1" }), 0);
	assert.equal(resolveTheme(8).accent, "ansi256(51)"); assert.equal(resolveTheme(8).brand, "ansi256(226)"); assert.equal(resolveTheme(0).accent, "");
});

test("resuming a compacted JSONL restores original conversation and its compaction boundary", async () => {
	const f = await fixture();
	try {
		const session = createSessionFile(f.root, join(f.root, "sessions"));
		appendEntry(session, { type: "message", message: { role: "user", content: [{ type: "text", text: "original user" }], timestamp: 0 } });
		appendEntry(session, { type: "message", message: { role: "assistant", content: [{ type: "text", text: "original answer" }], timestamp: 1, model: "fake", stopReason: "stop" } });
		appendEntry(session, { type: "compaction", summary: "summary", keptMessages: [], tokensBefore: 1000 });
		const h = harness(f.root, []), repl = new ReplController({ harness: h });
		try {
			await repl.submit(createPromptDraft("/resume")); await repl.submit(createPromptDraft("1"));
			assert.ok(repl.getSnapshot().transcript.some(item => item.kind === "user" && item.text === "original user"));
			assert.ok(repl.getSnapshot().transcript.some(item => item.kind === "compact" && item.summary === "summary"));
		} finally { repl.dispose(); }
	} finally { await f.cleanup(); }
});

test("generic Select routes inline text editing through the shared focus dispatcher", async () => {
	const dispatcher = new InputDispatcher(), stack = new FocusStack(dispatcher, REPL_KEYBINDINGS), stdout = new Capture(), stdin = new PassThrough();
	let value = "", confirmed = "";
	const options = [{ label: "Custom", value: "custom", type: "input" as const, onChange: (text: string) => { value = text; } }];
	const app = render(createElement(FocusStackProvider, { stack, children: createElement(Select, { options, columns: 50, onChange: (result: unknown) => { confirmed = String(result); } }) }), {
		stdout: stdout as unknown as NodeJS.WriteStream, stdin: stdin as unknown as NodeJS.ReadStream, debug: true, exitOnCtrlC: false, patchConsole: false,
	});
	const press = (name: string) => dispatcher.dispatch({ type: "key", name, raw: "", ctrl: false, alt: false, shift: false, meta: false });
	try {
		await pause(); press("enter"); await pause(); dispatcher.dispatch({ type: "text", text: "hello" }); press("backspace"); await pause(); press("enter");
		assert.equal(value, "hell"); assert.equal(confirmed, "custom");
	} finally { app.unmount(); app.cleanup(); stdin.destroy(); stdout.destroy(); }
});

test("approval keeps all choices and confirmation visible when diff lines exceed the viewport width", async () => {
	const policy = new PermissionPolicy(process.cwd(), true);
	const hunks = buildDiff("a", "old".repeat(150) + "\n", "new".repeat(150) + "\n").hunks;
	try {
		const frame = await snapshot(createElement(PermissionDialog, { state: { mode: "default", request: { id: "1", name: "edit", args: { path: "a" }, hunks }, selectedIndex: 0, editingFeedback: false }, policy, columns: 40, availableRows: 10 }), 40);
		assert.match(frame, /1\./); assert.match(frame, /2\./); assert.match(frame, /3\./); assert.match(frame, /Enter/);
		assert.ok(frame.split("\n").length <= 10);
	} finally { policy.dispose(); }
});
