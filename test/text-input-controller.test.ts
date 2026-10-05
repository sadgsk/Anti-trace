import assert from "node:assert/strict";
import test from "node:test";
import { TerminalInputParser } from "../src/cli/ink/terminal-input.ts";
import { InputDispatcher, type InputTarget } from "../src/cli/input/input-dispatcher.ts";
import { DEFAULT_KEYBINDINGS, type Keybinding } from "../src/cli/input/keybindings.ts";
import { TextInputController, type TextInputOptions } from "../src/cli/input/text-input-controller.ts";
import { createTextInputState, type TextInputState } from "../src/cli/input/text-input-state.ts";

const UP = "\x1b[A";
const DOWN = "\x1b[B";
const LEFT = "\x1b[D";
const RIGHT = "\x1b[C";
const HOME = "\x1b[H";
const END = "\x1b[F";

function makeInput(options: Partial<TextInputOptions> = {}) {
	const submitted: TextInputState[] = [];
	const changes: TextInputState[] = [];
	const controller = new TextInputController({
		availableColumns: 20,
		...options,
		onChange: state => { changes.push(state); options.onChange?.(state); },
		onSubmit: state => { submitted.push(state); options.onSubmit?.(state); },
	});
	const parser = new TerminalInputParser();
	const dispatcher = new InputDispatcher();
	dispatcher.configure([controller.target]);
	const feed = (bytes: string): void => {
		for (const event of parser.feed(Buffer.from(bytes, "utf8"))) dispatcher.dispatch(event);
	};
	return { controller, dispatcher, feed, submitted, changes };
}

test("same-chunk text and Enter submit the newest draft synchronously without automatic clearing", () => {
	const input = makeInput();
	input.feed("第一条\r追加\r");
	assert.deepEqual(input.submitted, [
		createTextInputState("第一条"),
		createTextInputState("第一条追加"),
	]);
	assert.deepEqual(input.controller.getState(), createTextInputState("第一条追加"));
	input.feed(LEFT + "!" + "\r");
	assert.deepEqual(input.submitted[2], createTextInputState("第一条追!加", 5));
	assert.deepEqual(input.submitted[0], createTextInputState("第一条"));
	input.feed(UP);
	assert.deepEqual(input.controller.getState(), createTextInputState("第一条追!加", 5));
});

test("Enter newline modifiers and backslash Enter edit at the cursor, while Ctrl+J keeps the backslash", () => {
	const cases = [
		["plain", "\r", "a\nZ"],
		["Shift", "\x1b[13;2u", "a\nZ"],
		["Alt", "\x1b[13;3u", "a\nZ"],
		["legacy Alt", "\x1b\r", "a\nZ"],
		["Meta", "\x1b[13;9u", "a\nZ"],
		["Ctrl+J", "\x1b[106;5u", "a\\\nZ"],
	] as const;
	for (const [label, key, expected] of cases) {
		const input = makeInput({ initialState: createTextInputState("a\\Z", 2) });
		input.feed(key);
		assert.deepEqual(input.controller.getState(), createTextInputState(expected, expected.length - 1), label);
		assert.deepEqual(input.submitted, [], label);
	}
	const input = makeInput({ initialState: createTextInputState("aZ", 1) });
	input.feed("\x1b[13;2u");
	assert.deepEqual(input.controller.getState(), createTextInputState("a\nZ", 2));
	input.feed("\r");
	assert.deepEqual(input.submitted, [createTextInputState("a\nZ", 2)]);
});

test("single-line mode consumes newline actions and submits a literal backslash", () => {
	const input = makeInput({ multiline: false, initialState: createTextInputState("value\\") });
	input.feed("\x1b[13;2u\x1b[106;5u\x1b[13;3u\r");
	assert.deepEqual(input.submitted, [createTextInputState("value\\")]);
	assert.deepEqual(input.controller.getState(), createTextInputState("value\\"));
});

test("default editing shortcuts operate on graphemes and keep Ctrl and arrow aliases aligned", () => {
	const family = "👩‍👩‍👧‍👦";
	const input = makeInput({ initialState: createTextInputState(`A${family}e\u0301Z`) });
	input.feed(LEFT + "\x7f");
	assert.deepEqual(input.controller.getState(), createTextInputState(`A${family}Z`, 1 + family.length));
	input.feed("\x02"); // Ctrl+B crosses the entire family emoji.
	assert.deepEqual(input.controller.getState(), createTextInputState(`A${family}Z`, 1));
	input.feed("\x06" + LEFT + "\x1b[3~"); // Ctrl+F, Left, Delete.
	assert.deepEqual(input.controller.getState(), createTextInputState("AZ", 1));
	input.feed("\x1b[104;5u\x04"); // Recognizable Ctrl+H and Ctrl+D.
	assert.deepEqual(input.controller.getState(), createTextInputState());
	input.feed("abcd" + LEFT + RIGHT);
	assert.deepEqual(input.controller.getState(), createTextInputState("abcd"));
});

test("Home and End actions and Ctrl+A/E follow visual rows", () => {
	const input = makeInput({ availableColumns: 3, initialState: createTextInputState("abcdef", 4) });
	input.feed(HOME);
	assert.deepEqual(input.controller.getState(), createTextInputState("abcdef", 3));
	input.feed(HOME); // Home at a row start goes to the previous visual row's start.
	assert.deepEqual(input.controller.getState(), createTextInputState("abcdef", 0));
	input.feed(END);
	assert.deepEqual(input.controller.getState(), createTextInputState("abcdef", 2));
	input.controller.replaceState(createTextInputState("ab\ncdef", 5));
	input.controller.setAvailableColumns(20);
	input.feed("\x01");
	assert.deepEqual(input.controller.getState(), createTextInputState("ab\ncdef", 3));
	input.feed("\x05");
	assert.deepEqual(input.controller.getState(), createTextInputState("ab\ncdef", 7));
});

test("printable Unicode key.text and ordinary text insert without raw escape debris", () => {
	const input = makeInput();
	input.feed("\x1b[20013u\x1b[97;2u\x1b[128512u");
	assert.deepEqual(input.controller.getState(), createTextInputState("中A😀"));
	input.feed("e\u0301");
	input.feed(LEFT + "!");
	assert.deepEqual(input.controller.getState(), createTextInputState("中A😀!e\u0301", 5));
	input.controller.replaceState(createTextInputState());
	input.feed("\x1b[57399u\x1b[57408u\x1b[27;1;128578~\x1b[64000u");
	assert.equal(input.controller.getState().text, `09🙂${String.fromCodePoint(64000)}`);
});

test("unbound function, modified, control and unknown keys do not alter text or submit", () => {
	const input = makeInput({ initialState: createTextInputState("draft", 2) });
	input.feed("\x1bOP\x1b[99;5u\x1b[1;2D\x1bz\x1b[13;6u\t\x00\x1b[999~\x1b[55296u\x1b[128u\x1b[57344u");
	assert.deepEqual(input.controller.getState(), createTextInputState("draft", 2));
	assert.deepEqual(input.changes, []);
	assert.deepEqual(input.submitted, []);
	assert.equal(input.controller.handleAction("app:unrecognized"), false);
});

test("vertical movement follows hard and soft rows and stays within the current input", () => {
	const input = makeInput({
		availableColumns: 3,
		initialState: createTextInputState("abcdef\nXY", 8),
	});
	input.feed(UP);
	assert.deepEqual(input.controller.getState(), createTextInputState("abcdef\nXY", 4));
	input.feed("\x10"); // Ctrl+P moves to the preceding wrapped row.
	assert.deepEqual(input.controller.getState(), createTextInputState("abcdef\nXY", 1));
	input.feed("\x0e"); // Ctrl+N returns to the next wrapped row.
	assert.deepEqual(input.controller.getState(), createTextInputState("abcdef\nXY", 4));
	input.feed(DOWN);
	assert.deepEqual(input.controller.getState(), createTextInputState("abcdef\nXY", 8));
	input.feed(UP + UP + UP);
	assert.deepEqual(input.controller.getState(), createTextInputState("abcdef\nXY", 1));
	input.feed(DOWN + DOWN + DOWN);
	assert.deepEqual(input.controller.getState(), createTextInputState("abcdef\nXY", 8));
});

test("single-row Up and Down preserve draft text and cursor without publishing changes", () => {
	for (const text of ["unsent", "", " \t "]) {
		const draft = createTextInputState(text, Math.min(2, text.length));
		const input = makeInput({ initialState: draft });
		input.feed(UP + UP + DOWN + DOWN + "\x10\x0e");
		assert.deepEqual(input.controller.getState(), draft);
		assert.deepEqual(input.changes, []);
		assert.deepEqual(input.submitted, []);
	}
});

test("initial state and replacement state snapshot caller data and correct cursor boundaries", () => {
	const initial = { text: "A😀Z", cursor: 2 };
	const input = makeInput({ initialState: initial });
	initial.text = "mutated";
	assert.deepEqual(input.controller.getState(), createTextInputState("A😀Z", 1));
	const replacement = { text: "new draft", cursor: 100 };
	input.controller.replaceState(replacement);
	replacement.text = "mutated";
	assert.deepEqual(input.controller.getState(), createTextInputState("new draft"));
	input.feed(UP + DOWN);
	assert.deepEqual(input.controller.getState(), createTextInputState("new draft"));
	input.controller.replaceState({ text: "A😀Z", cursor: 2 });
	assert.deepEqual(input.controller.getState(), createTextInputState("A😀Z", 1));
});

test("delegated paste synchronously gates a trailing Enter in the same chunk", () => {
	let pending = false;
	const pasted: string[] = [];
	const input = makeInput({
		initialState: createTextInputState("before"),
		onPaste: event => {
			assert.equal(event.isPasted, true);
			pending = true;
			pasted.push(event.text);
		},
		canSubmit: () => !pending,
	});
	input.feed("\x1b[200~line 1\r\nline 2\t\x1b[201~\r");
	assert.deepEqual(pasted, ["line 1\r\nline 2\t"]);
	assert.deepEqual(input.controller.getState(), createTextInputState("before"));
	assert.deepEqual(input.submitted, []);
	input.controller.replaceState(createTextInputState(pasted[0]!));
	pending = false;
	input.feed("\r");
	assert.deepEqual(input.submitted, [createTextInputState("line 1\r\nline 2\t")]);
});

test("ordinary complete paste inserts once at the cursor and never treats pasted controls as actions", () => {
	const input = makeInput({ initialState: createTextInputState("AZ", 1) });
	input.feed("\x1b[200~中\n\t\x03\x1b[201~");
	assert.deepEqual(input.controller.getState(), createTextInputState("A中\n\t\x03Z", 5));
	assert.deepEqual(input.changes, [createTextInputState("A中\n\t\x03Z", 5)]);
	assert.deepEqual(input.submitted, []);
});

test("focused outer context consumes its input, and existing editing actions can be rebound", () => {
	const input = makeInput({ initialState: createTextInputState("draft") });
	const outerText: string[] = [];
	let confirmations = 0;
	const outer: InputTarget = {
		id: Symbol("dialog"), context: "Dialog",
		actions: { "dialog:confirm": () => { confirmations++; } },
		onInput: event => { if (event.type === "text") outerText.push(event.text); },
	};
	const customBindings: readonly Keybinding[] = [
		...DEFAULT_KEYBINDINGS,
		{ context: "Dialog", chord: [{ name: "enter" }], action: "dialog:confirm" },
		{ context: "Input", chord: [{ name: "s", ctrl: true }], action: "input:left" },
		{ context: "Input", chord: [{ name: "x", ctrl: true }, { name: "l", ctrl: true }], action: "input:newline" },
	];
	input.dispatcher.configure([outer, input.controller.target], customBindings);
	input.feed("dialog text\r");
	assert.deepEqual(outerText, ["dialog text"]);
	assert.equal(confirmations, 1);
	assert.deepEqual(input.submitted, []);
	assert.deepEqual(input.controller.getState(), createTextInputState("draft"));
	input.dispatcher.configure([input.controller.target], customBindings);
	input.feed("\x13\x18\x0c");
	assert.deepEqual(input.controller.getState(), createTextInputState("draf\nt", 5));
});

test("controller publishes stable snapshots and unsubscribes listeners", () => {
	const input = makeInput();
	const before = input.controller.getSnapshot();
	let notifications = 0;
	const unsubscribe = input.controller.subscribe(() => { notifications++; });
	input.feed("abc");
	const edited = input.controller.getSnapshot();
	assert.notEqual(edited, before);
	assert.equal(input.controller.getSnapshot(), edited);
	assert.equal(notifications, 1);
	input.controller.setAvailableColumns(10);
	assert.equal(input.controller.getSnapshot().availableColumns, 10);
	assert.equal(input.changes.length, 1);
	assert.equal(notifications, 2);
	input.controller.setAvailableColumns(10);
	assert.equal(notifications, 2);
	assert.throws(() => input.controller.setAvailableColumns(0), /positive integer/);
	unsubscribe();
	input.feed(LEFT);
	assert.equal(notifications, 2);
	assert.deepEqual(input.controller.getState(), createTextInputState("abc", 2));
});

test("a synchronous subscriber can replace input without reversing change callbacks", () => {
	const input = makeInput();
	const unsubscribe = input.controller.subscribe(() => {
		if (input.controller.getState().text === "a") {
			input.controller.replaceState(createTextInputState("normalized"));
		}
	});
	input.feed("a");
	assert.deepEqual(input.changes.map(state => state.text), ["a", "normalized"]);
	assert.equal(input.controller.getState().text, "normalized");
	unsubscribe();
});
