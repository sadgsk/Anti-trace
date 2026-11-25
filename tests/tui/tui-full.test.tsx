import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname, basename } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import { createElement } from "react";
import { render } from "ink";
import stringWidth from "string-width";
import { Harness } from "../../src/harness/harness.ts";
import { ReplController } from "../../src/cli/repl/repl-controller.ts";
import { createPromptDraft } from "../../src/cli/input/prompt-draft.ts";
import { PromptInputController } from "../../src/cli/input/prompt-input-controller.ts";
import { PromptSuggestionsController } from "../../src/tui/suggestions/prompt-suggestions-controller.ts";
import { startTerminalRepl } from "../../src/cli/repl/terminal-repl.tsx";
import { PermissionPolicy, type PermissionSnapshot } from "../../src/cli/permissions/permission-policy.ts";
import { layoutPermissionDialog, PermissionDialog } from "../../src/tui/permissions/PermissionDialog.tsx";
import { railInset } from "../../src/tui/messages/MessageFrame.tsx";
import { TerminalScreen } from "../support/terminal-screen.ts";
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

test("terminal shows each child approval's origin and Escape denies only the visible request", async () => {
	const f = await terminalFixture([]);
	try {
		const request = (id: string, summary: string) => f.app.repl.permissions.beforeToolCall({
			...context("bash", { command: "echo shared" }), agentSource: { agent_id: id, summary },
		});
		const first = request("child-A", "inspect callers");
		const second = request("child-B", "inspect config");
		await until(() => f.output().includes("Agent child-A · inspect callers"));
		f.stdin.write("\x1b");
		assert.equal((await first)?.block, true);
		await until(() => f.output().includes("Agent child-B · inspect config"));
		f.stdin.write("1");
		assert.equal(await second, undefined);
		assert.equal(f.app.repl.permissions.getSnapshot().request, null);
	} finally { await f.close(); }
});

test("approval occupies the prompt slot below the chat across resizes and restores the draft", async () => {
	const f = await terminalFixture([]);
	const screen = new TerminalScreen(f.stdout.columns, f.stdout.rows);
	f.stdout.on("data", chunk => screen.write(chunk.toString()));
	try {
		f.app.repl.write("approval-context");
		f.stdin.write("unsent draft");
		await until(() => screen.text.includes("unsent draft"));
		const pending = f.app.repl.permissions.beforeToolCall(context("bash", { command: "echo approval-target" }));
		for (const [columns, rows] of [[100, 28], [52, 16], [36, 12], [100, 28]] as const) {
			screen.resize(columns, rows);
			Object.assign(f.stdout, { columns, rows }); f.stdout.emit("resize");
			await until(() => {
				const lines = screen.text.split("\n"), title = lines.findIndex(line => line.includes(" · bash "));
				const context = lines.findIndex(line => line.includes("approval-context"));
				const border = lines[title - 1] ?? "";
				return context >= 0 && title > context && border.indexOf("╭") === railInset(columns - 1)
					&& border.indexOf("┐") === columns - 2 && lines.some(line => line.includes("echo approval-target"))
					&& lines.some(line => line.includes("Enter")) && !screen.text.includes("unsent draft");
			});
		}
		f.stdin.write("3");
		const feedback = "Please review the working directory before running this command";
		f.stdin.write(feedback);
		await until(() => screen.text.includes(feedback));
		f.stdin.write("\r");
		assert.equal((await pending)?.reason, feedback);
		await until(() => screen.text.includes("unsent draft") && !screen.text.includes("approval-target"));
		f.app.prompt.reset();
		f.stdin.write("/");
		await until(() => screen.text.split("\n").some(line => {
			const command = line.indexOf("/help");
			return command >= 0 && stringWidth(line.slice(0, command)) > f.stdout.columns / 2;
		}));
	} finally { await f.close(); screen.dispose(); }
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

test("welcome aligns version and working directory at the lower right and keeps the path tail on resize", async () => {
	const cwd = "E:/pi-harness/终端/cli-agent";
	const narrow = await snapshot(createElement(WelcomeHeader, { columns: 60, rows: 24, cwd }), 60);
	const wide = await snapshot(createElement(WelcomeHeader, { columns: 120, rows: 24, cwd }), 120);
	for (const [frame, width] of [[narrow, 60], [wide, 120]] as const) {
		const rows = stripVTControlCharacters(frame).trimEnd().split("\n");
		const v = rows.findIndex(line => /v\d+\.\d+\.\d+$/.test(line));
		assert.equal(v, rows.length - 2);
		assert.equal(stringWidth(rows[v]!), width);
		assert.equal(stringWidth(rows[v + 1]!), width);
		assert.ok(rows[v + 1]!.endsWith("cli-agent"));
	}
	assert.ok(wide.includes(cwd));
	assert.match(narrow, /…[^\n]*cli-agent/);
	assert.doesNotMatch(narrow + wide, /ctx|medium|切换|╱─/);
	assert.match(narrow, /[\u2801-\u28ff]/);
	assert.ok(Math.max(...wide.split("\n").map(row => stringWidth(row))) > Math.max(...narrow.split("\n").map(row => stringWidth(row))));
	assert.equal(detectColorDepth({ isTTY: true } as NodeJS.WriteStream, { NO_COLOR: "1" }), 0);
	for (const depth of [4, 8, 24] as const) {
		const dark = Object.values(resolveTheme(depth, [41, 69, 102])), light = Object.values(resolveTheme(depth, [244, 239, 220]));
		assert.equal(new Set(dark).size, 1);
		assert.equal(new Set(light).size, 1);
		assert.notEqual(dark[0], light[0]);
	}
	assert.equal(resolveTheme(24, [41, 69, 102]).accent, "#FFFFFF"); assert.equal(resolveTheme(24, [244, 239, 220]).brand, "#101010"); assert.equal(resolveTheme(8).brand, ""); assert.equal(resolveTheme(0).accent, "");
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
		const state: PermissionSnapshot = { mode: "default", request: { id: "1", name: "edit", args: { path: "a" }, hunks }, selectedIndex: 0, editingFeedback: false };
		const frame = await snapshot(createElement(PermissionDialog, { state, policy, layout: layoutPermissionDialog(state, 40, 12) }), 40);
		assert.match(frame, /1\./); assert.match(frame, /2\./); assert.match(frame, /3\./); assert.match(frame, /Enter/);
		assert.ok(frame.split("\n").length <= 10);
	} finally { policy.dispose(); }
});
