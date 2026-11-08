import assert from "node:assert/strict";
import test, { after } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname, basename } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { createElement } from "react";
import { render } from "ink";
import { SLASH_COMMANDS, commandUsage, parseSlashCommand } from "../../src/cli/commands/command-registry.ts";
import { commandSuggestionQuery, getCommandSuggestions } from "../../src/tui/suggestions/suggestion-sources.ts";
import { PromptSuggestionsController } from "../../src/tui/suggestions/prompt-suggestions-controller.ts";
import { PromptSuggestions } from "../../src/tui/suggestions/PromptSuggestions.tsx";
import { InputDispatcher } from "../../src/cli/input/input-dispatcher.ts";
import { REPL_KEYBINDINGS } from "../../src/cli/input/keybindings.ts";
import { createPromptDraft } from "../../src/cli/input/prompt-draft.ts";
import { PromptInputController } from "../../src/cli/input/prompt-input-controller.ts";
import { ReplController, type ReplHarness } from "../../src/cli/repl/repl-controller.ts";
import { startTerminalRepl } from "../../src/cli/repl/terminal-repl.tsx";
import type { TerminalStreams } from "../../src/cli/ink/terminal-host.ts";
import type { TerminalInputEvent } from "../../src/cli/ink/terminal-input.ts";

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const delay = (ms = 70) => new Promise<void>(resolve => setTimeout(resolve, ms));
const cwd = resolve(mkdtempSync(join(tmpdir(), "slash-command-test-")));
after(() => { assert.equal(dirname(cwd), resolve(tmpdir())); assert.match(basename(cwd), /^slash-command-test-/); rmSync(cwd, { recursive: true, force: true }); });
const key = (name: string, modifiers: object = {}): TerminalInputEvent => ({
	type: "key", name, raw: "", ctrl: false, alt: false, shift: false, meta: false, ...modifiers,
});

function harnessFixture(overrides: Partial<ReplHarness> = {}) {
	const calls = { prompts: [] as string[], newSession: 0, resume: 0, abort: 0, context: 0, compact: 0 };
	const harness: ReplHarness = {
		prompt: async text => { calls.prompts.push(text); }, abort: () => { calls.abort++; },
		subscribe: () => () => {}, newSession: () => { calls.newSession++; },
		listSessions: () => [], resumeAt: () => { calls.resume++; return true; },
		setContextWindow: value => { calls.context = value; }, contextUsage: () => ({ used: 0, window: undefined }),
		manualCompact: async () => { calls.compact++; return "below-threshold"; }, ...overrides,
	};
	return { harness, calls };
}

function fixture(overrides: Partial<ReplHarness> = {}) {
	const { harness, calls } = harnessFixture(overrides);
	let prompt!: PromptInputController;
	const repl = new ReplController({ harness, cwd, onAccept: () => prompt.reset() });
	prompt = new PromptInputController({ availableColumns: 79, canSubmit: () => repl.canSubmit(),
		onSubmit: draft => { void repl.submit(draft); } });
	const menu = new PromptSuggestionsController(prompt, repl);
	const dispatcher = new InputDispatcher();
	const configure = () => dispatcher.configure(menu.getSnapshot().open ? [menu.target, prompt.target] : [prompt.target], REPL_KEYBINDINGS);
	const unsubscribe = menu.subscribe(configure);
	configure();
	return { prompt, repl, menu, dispatcher, calls,
		type: (text: string) => dispatcher.dispatch({ type: "text", text }),
		press: (name: string, modifiers?: object) => dispatcher.dispatch(key(name, modifiers)),
		close: () => { unsubscribe(); menu.dispose(); prompt.dispose(); repl.dispose(); },
	};
}

test("registry supplies every parser entry and every help entry", async () => {
	const f = fixture();
	try {
		assert.equal(new Set(SLASH_COMMANDS.map(command => command.name)).size, 13);
		for (const command of SLASH_COMMANDS) {
			assert.equal(parseSlashCommand(` /${command.name} `)?.command.name, command.name);
		}
		await f.repl.submit(createPromptDraft("/help"));
		const help = f.repl.getSnapshot().entries.map(entry => entry.text).join("\n");
		for (const command of SLASH_COMMANDS) assert.ok(help.includes(commandUsage(command)));
		assert.deepEqual(f.calls.prompts, []);
	} finally { f.close(); }
});

test("parser preserves multiline, unknown slash text, resume selection and argument whitespace", () => {
	for (const text of ["/", "/unknown", "/new\n", "/new\r\nother", "/resume 2", "/resume   2", "/tmp/file", "text /new"]) {
		assert.equal(parseSlashCommand(text), null, text);
	}
	assert.equal(parseSlashCommand('/config E:\\a folder\\byok.json')?.argument, 'E:\\a folder\\byok.json');
	assert.equal(parseSlashCommand("/context 123")?.argument, "123");
	assert.equal(parseSlashCommand("/new extra")?.argument, "extra");
});

test("suggestions require one plain command token and prioritize an exact name", () => {
	assert.equal(commandSuggestionQuery(createPromptDraft("/")), "");
	for (const text of ["hi /", " /new", "/new ", "/model main", "/new\n", "/tmp/file", "/命令"]) {
		assert.equal(commandSuggestionQuery(createPromptDraft(text)), null, text);
	}
	assert.equal(commandSuggestionQuery(createPromptDraft("/new", 1)), null);
	assert.deepEqual(getCommandSuggestions("thinking").map(item => item.name), ["thinking", "thinking-display"]);
	assert.deepEqual(getCommandSuggestions("no-match"), []);
});

test("menu starts hidden, opens with slash, filters, and closes on deletion", () => {
	const f = fixture();
	try {
		assert.equal(f.menu.getSnapshot().open, false);
		f.type("/");
		assert.equal(f.menu.getSnapshot().open, true);
		assert.equal(f.menu.getSnapshot().items.length, 13);
		f.type("th");
		assert.deepEqual(f.menu.getSnapshot().items.map(item => item.name), ["thinking", "thinking-display"]);
		assert.equal(f.prompt.getDraft().text, "/th");
		f.press("backspace"); f.press("backspace"); f.press("backspace");
		assert.equal(f.menu.getSnapshot().open, false);
	} finally { f.close(); }
});

test("arrows wrap through the full registry without moving the draft cursor", () => {
	const f = fixture();
	try {
		f.type("/"); f.press("up");
		assert.equal(f.menu.getSnapshot().items[f.menu.getSnapshot().selectedIndex]?.name, "exit");
		assert.equal(f.prompt.getDraft().cursor, 1);
		f.press("down"); assert.equal(f.menu.getSnapshot().selectedIndex, 0);
		f.press("down"); assert.equal(f.menu.getSnapshot().selectedIndex, 1);
		f.type("re"); assert.equal(f.menu.getSnapshot().selectedIndex, 0);
	} finally { f.close(); }
});

test("Enter executes the selected command exactly once and clears the prompt", async () => {
	const f = fixture();
	try {
		f.type("/"); f.press("down"); f.press("enter");
		await tick();
		assert.equal(f.calls.newSession, 1);
		assert.deepEqual(f.calls.prompts, []);
		assert.equal(f.prompt.getDraft().text, "");
		assert.equal(f.menu.getSnapshot().open, false);
		f.press("enter"); await tick(); assert.equal(f.calls.newSession, 1);
	} finally { f.close(); }
});

test("Tab completes without executing and completion supports undo and redo", async () => {
	const f = fixture();
	try {
		f.type("/n"); f.press("tab");
		assert.equal(f.prompt.getDraft().text, "/new");
		assert.equal(f.menu.getSnapshot().open, false);
		assert.equal(f.calls.newSession, 0);
		f.press("z", { ctrl: true });
		assert.equal(f.prompt.getDraft().text, "/n");
		assert.equal(f.menu.getSnapshot().open, true);
		f.press("y", { ctrl: true });
		assert.equal(f.prompt.getDraft().text, "/new");
		f.press("enter"); await tick(); assert.equal(f.calls.newSession, 1);
	} finally { f.close(); }
});

test("model command accepts Enter directly instead of requiring a typed argument", async () => {
	const f = fixture();
	try {
		f.type("/mo"); f.press("enter");
		await tick(); assert.equal(f.prompt.getDraft().text, "");
		assert.equal(f.menu.getSnapshot().open, false);
		assert.match(f.repl.getSnapshot().entries.at(-1)!.text, /未使用 BYOK/);
		assert.deepEqual(f.calls.prompts, []);
	} finally { f.close(); }
});

test("optional argument completion preserves the old context command path", async () => {
	const f = fixture();
	try {
		f.type("/con"); f.press("tab");
		assert.equal(f.prompt.getDraft().text, "/context ");
		f.type("65536"); f.press("enter"); await tick();
		assert.equal(f.calls.context, 65536);
		assert.deepEqual(f.calls.prompts, []);
	} finally { f.close(); }
});

test("Esc dismisses without changing the draft and typing reopens the menu", () => {
	const f = fixture();
	try {
		f.type("/"); f.press("escape");
		assert.equal(f.prompt.getDraft().text, "/");
		assert.equal(f.menu.getSnapshot().open, false);
		f.prompt.setAvailableColumns(20); assert.equal(f.menu.getSnapshot().open, false);
		f.type("n"); assert.equal(f.menu.getSnapshot().open, true);
	} finally { f.close(); }
});

test("empty matches retain ordinary slash text submission", async () => {
	const f = fixture();
	try {
		f.type("/unknown"); f.press("tab");
		assert.equal(f.prompt.getDraft().text, "/unknown");
		f.press("enter"); await tick();
		assert.deepEqual(f.calls.prompts, ["/unknown"]);
	} finally { f.close(); }
});

test("Shift+Enter inserts a newline and ordinary multiline drafts submit unchanged", async () => {
	const f = fixture();
	try {
		f.type("/new"); f.press("enter", { shift: true });
		assert.equal(f.prompt.getDraft().text, "/new\n");
		assert.equal(f.menu.getSnapshot().open, false);
		f.type("hello"); f.press("enter"); await tick();
		assert.deepEqual(f.calls.prompts, ["/new\nhello"]);
		assert.equal(f.calls.newSession, 0);
	} finally { f.close(); }
});

test("pending paste hides the menu and cannot execute a stale selection", async () => {
	const f = fixture();
	try {
		f.type("/");
		f.dispatcher.dispatch({ type: "paste", text: "new", isPasted: true });
		assert.equal(f.menu.getSnapshot().open, false);
		f.press("enter"); assert.equal(f.calls.newSession, 0);
		f.prompt.textInput.pasteHandler.flush();
		assert.equal(f.prompt.getDraft().text, "/new");
		assert.equal(f.menu.getSnapshot().open, true);
		assert.equal(f.calls.newSession, 0);
		f.press("enter"); await tick(); assert.equal(f.calls.newSession, 1);
	} finally { f.close(); }
});

test("attachments and folded text cannot activate command completion", async () => {
	const f = fixture();
	try {
		f.dispatcher.dispatch({ type: "paste", text: "/new\n".repeat(300), isPasted: true });
		f.prompt.textInput.pasteHandler.flush();
		assert.equal(f.prompt.getDraft().references.length, 1);
		assert.equal(f.menu.getSnapshot().open, false);
		f.press("enter"); await tick();
		assert.deepEqual(f.calls.prompts, ["/new\n".repeat(300)]);
	} finally { f.close(); }
});

test("busy turns gate menu submission and reopen the draft when the turn ends", async () => {
	let finish!: () => void;
	const f = fixture({ prompt: () => new Promise<void>(resolve => { finish = resolve; }) });
	try {
		const turn = f.repl.submit(createPromptDraft("work"));
		f.type("/new"); f.press("enter");
		assert.equal(f.menu.getSnapshot().open, false);
		assert.equal(f.prompt.getDraft().text, "/new");
		assert.equal(f.calls.newSession, 0);
		finish(); await turn;
		assert.equal(f.menu.getSnapshot().open, true);
		f.press("enter"); await tick(); assert.equal(f.calls.newSession, 1);
	} finally { f.close(); }
});

test("resume selection owns input until it is cancelled", async () => {
	const f = fixture({ listSessions: () => [{ filePath: "saved.jsonl", name: "saved", lastOpenedAt: 1 }] });
	try {
		f.type("/resume"); f.press("enter"); await tick();
		assert.equal(f.repl.getSnapshot().resumeChoices?.length, 1);
		f.type("/new"); assert.equal(f.menu.getSnapshot().open, false);
		f.press("enter"); await tick(); assert.equal(f.calls.newSession, 0);
		f.prompt.reset(); f.press("enter"); await tick();
		assert.equal(f.repl.getSnapshot().resumeChoices, null);
		f.type("/"); assert.equal(f.menu.getSnapshot().open, true);
	} finally { f.close(); }
});

test("direct no-argument misuse remains a usage error rather than a model prompt", async () => {
	const f = fixture();
	try {
		await f.repl.submit(createPromptDraft("/new extra"));
		assert.equal(f.calls.newSession, 0);
		assert.deepEqual(f.calls.prompts, []);
		assert.match(f.repl.getSnapshot().entries.at(-1)!.text, /用法：\/new/);
	} finally { f.close(); }
});

class Output extends Writable {
	columns = 80; rows = 24; isTTY = false; frames: string[] = [];
	_write(chunk: Buffer, _encoding: string, callback: () => void) { this.frames.push(chunk.toString()); callback(); }
}

test("Ink menu bounds its viewport, scrolls to the last item and renders an empty state", async () => {
	const f = fixture(); const stdout = new Output(); const stdin = new PassThrough();
	const app = render(createElement(PromptSuggestions, { controller: f.menu, availableRows: 4 }), {
		stdout: stdout as unknown as NodeJS.WriteStream, stdin: stdin as unknown as NodeJS.ReadStream,
		debug: true, patchConsole: false, exitOnCtrlC: false,
	});
	const frame = () => stdout.frames.at(-1)!.replace(/\x1b\[[0-9;]*m/g, "");
	try {
		f.type("/"); await delay();
		assert.match(frame(), /\/help/); assert.doesNotMatch(frame(), /\/exit/);
		assert.equal(frame().split("\n").length, 4);
		f.press("up"); await delay();
		assert.match(frame(), /\/exit/); assert.match(frame(), /13\/13/);
		stdout.columns = 20; app.rerender(createElement(PromptSuggestions, { controller: f.menu, availableRows: 2 }));
		await delay(); assert.equal(frame().split("\n").length, 2);
		f.type("unknown"); await delay(); assert.match(frame(), /无匹配命令/);
	} finally { app.unmount(); app.cleanup(); f.close(); }
});

class Input extends PassThrough {
	isTTY = true; isRaw = false;
	setRawMode(value: boolean) { this.isRaw = value; return this; }
}
class TerminalOutput extends PassThrough { isTTY = true; columns = 80; rows = 24; }

test("terminal host shows no command list at startup and connects slash navigation, resize and cleanup", async () => {
	const { harness, calls } = harnessFixture();
	const stdin = new Input(); const stdout = new TerminalOutput(); let output = "";
	stdout.on("data", chunk => { output += chunk.toString(); });
	const terminal = startTerminalRepl({ harness, cwd, streams: { stdin, stdout } as unknown as TerminalStreams });
	try {
		await delay(); assert.match(output, /输入 \/ 查看命令/); assert.doesNotMatch(output, /\/help|\/new|\/exit/);
		assert.equal(stdin.listenerCount("data"), 1);
		stdin.write("/"); await delay(); assert.equal(terminal.suggestions.getSnapshot().open, true);
		stdin.write("\x1b[B"); stdin.write("\r"); await delay(); assert.equal(calls.newSession, 1);
		stdin.write("/con"); stdin.write("\t"); assert.equal(terminal.prompt.getDraft().text, "/context ");
		stdin.write("1234"); stdin.write("\r"); await delay(); assert.equal(calls.context, 1234);
		stdin.write("/"); stdin.write("\x1b[A");
		assert.equal(terminal.suggestions.getSnapshot().selectedIndex, 12);
		stdout.columns = 24; stdout.rows = 10; stdout.emit("resize"); await delay();
		assert.equal(terminal.suggestions.getSnapshot().selectedIndex, 12);
		stdin.write("\x1b"); await delay(); assert.equal(terminal.suggestions.getSnapshot().open, false);
		assert.equal(terminal.prompt.getDraft().text, "/");
		stdin.write("\x03"); assert.equal(terminal.prompt.getDraft().text, "");
		stdin.write("/exit"); stdin.write("\r"); await terminal.done;
		assert.equal(stdin.isRaw, false); assert.equal(stdin.listenerCount("data"), 0);
	} finally { terminal.stop(); }
});
