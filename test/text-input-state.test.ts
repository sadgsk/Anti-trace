import assert from "node:assert/strict";
import test from "node:test";
import {
	getTextInputOffset,
	getTextInputPosition,
	layoutTextInput,
	splitTextInputLine,
} from "../src/cli/input/text-input-layout.ts";
import { applyTextInputAction, createTextInputState } from "../src/cli/input/text-input-state.ts";

test("cursor clamping and horizontal motion keep emoji and combining characters whole", () => {
	const emoji = "👩🏽‍💻";
	const accented = "e\u0301";
	const text = `A${emoji}${accented}B`;
	assert.equal(createTextInputState(text, 2).cursor, 1);
	assert.equal(createTextInputState(text, 1 + emoji.length + 1).cursor, 1 + emoji.length);
	assert.equal(createTextInputState(text, -3).cursor, 0);
	assert.equal(createTextInputState(text, text.length + 5).cursor, text.length);

	let state = createTextInputState(text, 1);
	state = applyTextInputAction(state, { type: "move", direction: "right" });
	assert.equal(state.cursor, 1 + emoji.length);
	state = applyTextInputAction(state, { type: "move", direction: "right" });
	assert.equal(state.cursor, 1 + emoji.length + accented.length);
	state = applyTextInputAction(state, { type: "move", direction: "left" });
	assert.equal(state.cursor, 1 + emoji.length);
	state = applyTextInputAction(state, { type: "move", direction: "left" });
	assert.deepEqual(state, { text, cursor: 1 });
});

test("backspace and delete each remove one complete visible character", () => {
	const emoji = "👨‍👩‍👧‍👦";
	const text = `a${emoji}e\u0301z`;
	assert.deepEqual(
		applyTextInputAction(createTextInputState(text, 1 + emoji.length), { type: "delete", direction: "backward" }),
		{ text: "ae\u0301z", cursor: 1 },
	);
	assert.deepEqual(
		applyTextInputAction(createTextInputState(text, 1), { type: "delete", direction: "forward" }),
		{ text: "ae\u0301z", cursor: 1 },
	);
	assert.deepEqual(
		applyTextInputAction(createTextInputState("ae\u0301z", 1), { type: "delete", direction: "forward" }),
		{ text: "az", cursor: 1 },
	);
});

test("insertion can join adjacent characters and keeps the cursor after the joined character", () => {
	assert.deepEqual(
		applyTextInputAction(createTextInputState("ex", 1), { type: "insert", text: "\u0301" }),
		{ text: "e\u0301x", cursor: 2 },
	);
	assert.deepEqual(
		applyTextInputAction(createTextInputState("\u0301x", 0), { type: "insert", text: "e" }),
		{ text: "e\u0301x", cursor: 2 },
	);
	assert.deepEqual(
		applyTextInputAction(createTextInputState("👩💻", "👩".length), { type: "insert", text: "\u200d" }),
		{ text: "👩‍💻", cursor: "👩‍💻".length },
	);
});

test("deleting a separator joins clusters without leaving the cursor inside them", () => {
	for (const direction of ["backward", "forward"] as const) {
		const cursor = direction === "backward" ? 2 : 1;
		assert.deepEqual(
			applyTextInputAction(createTextInputState("a\n\u0301b", cursor), { type: "delete", direction }),
			{ text: "a\u0301b", cursor: 0 },
		);
	}
	assert.deepEqual(
		applyTextInputAction(createTextInputState("🇦\n🇧", "🇦\n".length), { type: "delete", direction: "backward" }),
		{ text: "🇦🇧", cursor: 0 },
	);
});

test("CRLF is edited as one newline and document boundaries do not consume text", () => {
	const text = "a\r\nb";
	assert.equal(applyTextInputAction(createTextInputState(text, 3), { type: "move", direction: "left" }).cursor, 1);
	assert.equal(applyTextInputAction(createTextInputState(text, 1), { type: "move", direction: "right" }).cursor, 3);
	for (const direction of ["backward", "forward"] as const) {
		assert.deepEqual(
			applyTextInputAction(createTextInputState(text, direction === "backward" ? 3 : 1), { type: "delete", direction }),
			{ text: "ab", cursor: 1 },
		);
	}
	assert.deepEqual(applyTextInputAction(createTextInputState(text, 0), { type: "delete", direction: "backward" }), { text, cursor: 0 });
	assert.deepEqual(applyTextInputAction(createTextInputState(text), { type: "delete", direction: "forward" }), { text, cursor: text.length });
	assert.deepEqual(applyTextInputAction(createTextInputState(), { type: "move", direction: "left" }), { text: "", cursor: 0 });
});

test("CRLF, CR and LF retain source offsets and consecutive trailing empty rows", () => {
	const layout = layoutTextInput("a\r\nb\rc\n\n", 4);
	assert.deepEqual(layout.lines.map(line => line.text), ["a", "b", "c", "", ""]);
	for (const [offset, line, column] of [
		[0, 0, 0], [1, 0, 1], [3, 1, 0], [4, 1, 1],
		[5, 2, 0], [6, 2, 1], [7, 3, 0], [8, 4, 0],
	]) {
		assert.deepEqual(getTextInputPosition(layout, offset!), { line, column });
		assert.equal(getTextInputOffset(layout, { line: line!, column: column! }), offset);
	}
	assert.deepEqual(layoutTextInput("", 4).lines.map(line => line.text), [""]);
});

test("wrapping respects CJK and emoji width, tab stops and existing spaces", () => {
	const layout = layoutTextInput("中😀a\tb", 4);
	assert.deepEqual(layout.lines.map(line => line.text), ["中😀", "a   ", "b"]);
	assert.deepEqual(layout.lines.map(line => line.width), [4, 4, 1]);
	assert.deepEqual(getTextInputPosition(layout, 1), { line: 0, column: 2 });
	assert.deepEqual(getTextInputPosition(layout, 3), { line: 1, column: 0 });
	assert.deepEqual(getTextInputPosition(layout, 4), { line: 1, column: 1 });
	assert.deepEqual(getTextInputPosition(layout, 5), { line: 2, column: 0 });
	assert.deepEqual(layoutTextInput("ab  cd", 3).lines.map(line => line.text), ["ab ", " cd"]);
	assert.deepEqual(layoutTextInput("abc\tZ", 3).lines.map(line => line.text), ["abc", "   ", "Z"]);
});

test("vertical movement follows display rows and soft-wrap boundaries belong to the next row", () => {
	const text = "abcdefghi";
	const layout = layoutTextInput(text, 4);
	assert.deepEqual(getTextInputPosition(layout, 4), { line: 1, column: 0 });
	assert.equal(getTextInputOffset(layout, { line: 0, column: 4 }), 3);
	assert.deepEqual(getTextInputPosition(layout, getTextInputOffset(layout, { line: 0, column: 4 })), { line: 0, column: 3 });
	let state = createTextInputState(text);
	state = applyTextInputAction(state, { type: "move", direction: "up", availableColumns: 4 });
	assert.equal(state.cursor, 5);
	state = applyTextInputAction(state, { type: "move", direction: "up", availableColumns: 4 });
	assert.equal(state.cursor, 1);
	assert.deepEqual(applyTextInputAction(state, { type: "move", direction: "up", availableColumns: 4 }), state);
	state = applyTextInputAction(state, { type: "move", direction: "down", availableColumns: 4 });
	assert.equal(state.cursor, 5);
	state = applyTextInputAction(state, { type: "move", direction: "down", availableColumns: 4 });
	assert.equal(state.cursor, 9);
	assert.deepEqual(applyTextInputAction(state, { type: "move", direction: "down", availableColumns: 4 }), state);
	assert.equal(applyTextInputAction(createTextInputState(text, 4), { type: "move", direction: "up", availableColumns: 4 }).cursor, 0);
});

test("vertical movement snaps before a wide character and uses the current column after a short row", () => {
	assert.deepEqual(
		applyTextInputAction(createTextInputState("x\n中a", 1), { type: "move", direction: "down", availableColumns: 4 }),
		{ text: "x\n中a", cursor: 2 },
	);
	let state = createTextInputState("abcde\n1234");
	state = applyTextInputAction(state, { type: "move", direction: "up", availableColumns: 4 });
	assert.equal(state.cursor, 5);
	state = applyTextInputAction(state, { type: "move", direction: "up", availableColumns: 4 });
	assert.equal(state.cursor, 1);
	assert.equal(
		applyTextInputAction(createTextInputState("abcd\n12345", 4), { type: "move", direction: "down", availableColumns: 4 }).cursor,
		8,
	);
});

test("narrow rows and unsafe display characters preserve the submitted source", () => {
	const text = "中👩‍💻\t\x1b\ud800A";
	const state = createTextInputState(text);
	const layout = layoutTextInput(state.text, 1);
	assert.deepEqual(layout.lines.map(line => line.text), ["�", "�", " ", "�", "�", "A"]);
	assert.equal(state.text, text);
	assert.deepEqual(getTextInputPosition(layout, 1), { line: 1, column: 0 });
	assert.deepEqual(getTextInputPosition(layout, "中👩‍💻\t\x1b".length), { line: 4, column: 0 });
	assert.deepEqual(layoutTextInput("\x00\x1b\x9b\ud800\udc00", 8).lines.map(line => line.text), ["���𐀀"]);
	assert.equal(layoutTextInput("\ud800A", 4).lines[0]!.width, 2);
	assert.equal(layoutTextInput("\udc00A", 4).lines[0]!.width, 2);
	assert.equal(layoutTextInput("A\ud800", 4).lines[0]!.width, 2);
});

test("cursor display highlights whole characters, individual tab spaces, and a space at the end", () => {
	const line = layoutTextInput("a\t中👩‍💻", 8).lines[0]!;
	assert.deepEqual(splitTextInputLine(line, 1), { before: "a", cursor: " ", after: "  中👩‍💻" });
	assert.deepEqual(splitTextInputLine(line, 4), { before: "a   ", cursor: "中", after: "👩‍💻" });
	assert.deepEqual(splitTextInputLine(line, 5), { before: "a   ", cursor: "中", after: "👩‍💻" });
	assert.deepEqual(splitTextInputLine(line, 6), { before: "a   中", cursor: "👩‍💻", after: "" });
	assert.deepEqual(splitTextInputLine(line, 8), { before: "a   中👩‍💻", cursor: " ", after: "" });
	assert.deepEqual(splitTextInputLine(layoutTextInput("e\u0301x", 4).lines[0]!, 0), { before: "", cursor: "e\u0301", after: "x" });
});

test("standalone zero-width source clusters get visible placeholders without changing source offsets", () => {
	const layout = layoutTextInput("\u200b\u200ca", 4);
	assert.deepEqual(layout.lines.map(line => line.text), ["��a"]);
	assert.deepEqual(getTextInputPosition(layout, 0), { line: 0, column: 0 });
	assert.deepEqual(getTextInputPosition(layout, 2), { line: 0, column: 2 });
	assert.equal(getTextInputOffset(layout, { line: 0, column: 2 }), 2);
	assert.deepEqual(splitTextInputLine({ ...layout.lines[0]!, text: "\u200b\u200ca" }, 0), {
		before: "\u200b\u200c", cursor: "a", after: "",
	});
});

test("every target display row keeps ownership of its returned source offset", () => {
	for (const text of ["abcd", "中😀x", "\t\tq", "a\r\nb\n", "\n\n", "\u200b\u200ca", "e\u0301👩‍💻\n中"]) {
		for (const columns of [1, 2, 3, 4]) {
			const layout = layoutTextInput(text, columns);
			for (let line = 0; line < layout.lines.length; line++) {
				for (let column = 0; column <= columns + 1; column++) {
					const offset = getTextInputOffset(layout, { line, column });
					assert.equal(getTextInputPosition(layout, offset).line, line, `${JSON.stringify(text)} at ${columns} columns, row ${line}`);
				}
			}
		}
	}
});

test("layout rejects invalid available widths instead of losing content or looping", () => {
	for (const columns of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
		assert.throws(() => layoutTextInput("abc", columns), RangeError);
		assert.throws(() => applyTextInputAction(createTextInputState(), { type: "move", direction: "up", availableColumns: columns }), RangeError);
	}
	assert.throws(() => getTextInputOffset(layoutTextInput("a", 1), { line: 2, column: 0 }), RangeError);
});
