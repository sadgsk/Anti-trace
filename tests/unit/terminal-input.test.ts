import assert from "node:assert/strict";
import test from "node:test";
import { TerminalInputParser, type TerminalInputEvent } from "../../src/cli/ink/terminal-input.ts";

test("UTF-8 byte splits preserve Chinese and emoji without replacement characters", () => {
	const parser = new TerminalInputParser();
	const events = [...Buffer.from("中😀文")].flatMap((byte) => parser.feed(Buffer.from([byte])));
	assert.equal(events.filter((event) => event.type === "text").map((event) => event.text).join(""), "中😀文");
});

test("bracketed paste remains atomic at every possible chunk boundary", () => {
	const text = "first\r\n第二行\x03😀";
	const bytes = Buffer.from(`\x1b[200~${text}\x1b[201~\r`);
	for (let split = 0; split <= bytes.length; split++) {
		const parser = new TerminalInputParser();
		const events = [...parser.feed(bytes.subarray(0, split)), ...parser.feed(bytes.subarray(split))];
		assert.equal(events.length, 2, `split at byte ${split}`);
		assert.deepEqual(events[0], { type: "paste", text, isPasted: true });
		assert.ok(events[1]?.type === "key" && events[1].name === "enter");
	}
});

test("CRLF split across chunks produces one Enter", () => {
	const parser = new TerminalInputParser();
	const events = [...parser.feed(Buffer.from("\r")), ...parser.feed(Buffer.from("\nx"))];
	assert.deepEqual(events.map((event) => event.type === "key" ? event.name : event.type), ["enter", "text"]);
});

for (const [raw, name, modifiers] of [
	["\x1b[A", "up", {}], ["\x1bOD", "left", {}], ["\x1b[3~", "delete", {}],
	["\x1b[Z", "tab", { shift: true }], ["\x03", "c", { ctrl: true }],
	["\x1b[13;3u", "enter", { alt: true }], ["\x1b[27;2;13~", "enter", { shift: true }],
] as const) test(`decodes ${JSON.stringify(raw)} as ${name}`, () => {
	const event = new TerminalInputParser().feed(Buffer.from(raw))[0];
	assert.ok(event?.type === "key");
	assert.equal(event.name, name);
	for (const [modifier, value] of Object.entries(modifiers)) assert.equal(event[modifier as "ctrl" | "alt" | "shift"], value);
});

test("mouse and terminal responses cannot become printable input", () => {
	const parser = new TerminalInputParser();
	const events = parser.feed(Buffer.from("\x1b[<64;10;5M\x1b]0;title\x07\x1b[?1;2c"));
	assert.deepEqual(events.map((event) => event.type), ["mouse", "response", "response"]);
});

test("an incomplete escape waits until explicitly flushed", () => {
	const parser = new TerminalInputParser();
	assert.deepEqual(parser.feed(Buffer.from("\x1b")), []);
	assert.equal(parser.awaitingEscape, true);
	const events: TerminalInputEvent[] = parser.feed(null);
	assert.ok(events[0]?.type === "key" && events[0].name === "escape");
	assert.equal(parser.awaitingEscape, false);
});
