import assert from "node:assert/strict";
import { once } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { TerminalInput, type TerminalInputEvent } from "../src/cli/input/stash/terminal.ts";

class FakeTTY extends PassThrough {
	isTTY = true;
	isRaw = false;
	readonly rawChanges: boolean[] = [];

	setRawMode(mode: boolean): void {
		this.isRaw = mode;
		this.rawChanges.push(mode);
	}
}

function makeTTY(initiallyRaw = false): {
	input: FakeTTY;
	output: PassThrough;
	events: TerminalInputEvent[];
	outputText: () => string;
	terminal: TerminalInput;
} {
	const input = new FakeTTY();
	input.isRaw = initiallyRaw;
	const output = new PassThrough() as PassThrough & { isTTY: boolean };
	output.isTTY = true;
	const outputChunks: Buffer[] = [];
	output.on("data", (chunk: Buffer) => outputChunks.push(chunk));
	const events: TerminalInputEvent[] = [];
	const terminal = new TerminalInput({ input, output, onEvent: (event) => events.push(event) });
	return { input, output, events, outputText: () => Buffer.concat(outputChunks).toString(), terminal };
}

test("bracketed paste stays atomic across every byte boundary and a trailing Enter is separate", () => {
	const { input, events, terminal } = makeTTY();
	terminal.start();
	const bytes = Buffer.from("\x1b[200~第一行\r\n第二行\r\n\x03末尾\x1b[201~\r", "utf8");
	for (const byte of bytes) input.write(Buffer.from([byte]));
	assert.deepEqual(events, [
		{ type: "paste", text: "第一行\n第二行\n末尾" },
		{ type: "key", key: "enter", raw: "\r", ctrl: false, alt: false, shift: false },
	]);
	terminal.stop();
});

test("a slowly split paste delimiter is not mistaken for Escape", async () => {
	const { input, events, terminal } = makeTTY();
	terminal.start();
	input.write("\x1b");
	await new Promise((resolve) => setTimeout(resolve, 60));
	input.write("[2");
	await new Promise((resolve) => setTimeout(resolve, 280));
	input.write("00~a\rsecond\x1b[201~");
	assert.deepEqual(events, [{ type: "paste", text: "a\nsecond" }]);
	terminal.stop();
});

test("text decoding keeps a UTF-8 character intact when its bytes are split", () => {
	const { input, events, terminal } = makeTTY();
	terminal.start();
	const bytes = Buffer.from("中😀", "utf8");
	for (const byte of bytes) input.write(Buffer.from([byte]));
	assert.deepEqual(events, [{ type: "text", text: "中" }, { type: "text", text: "😀" }]);
	terminal.stop();
});

test("key sequences preserve arrows, editing keys, modifiers, and clipboard shortcuts", () => {
	const { input, events, terminal } = makeTTY();
	terminal.start();
	input.write("\x1b[D\x1b[3~\x1b[1;2C\x1b[H\x1b[F\x03\x04\x07\x0a\x16\x1bv");
	assert.deepEqual(events.filter((event) => event.type === "key").map((event) => [event.key, event.shift]), [
		["left", false], ["delete", false], ["right", true], ["home", false], ["end", false],
		["ctrl-c", false], ["ctrl-d", false], ["ctrl-g", false], ["ctrl-j", false],
		["ctrl-v", false], ["alt-v", false],
	]);
	terminal.stop();
});

test("an unmarked CRLF across chunks is one Enter and a modified Enter stays a key", () => {
	const { input, events, terminal } = makeTTY();
	terminal.start();
	input.write("\r");
	input.write("\n");
	input.write("\x1b[13;2u");
	assert.deepEqual(events.filter((event) => event.type === "key").map((event) => [event.key, event.shift]), [
		["enter", false],
		["enter", true],
	]);
	terminal.stop();
});

test("common editing controls and modified Home/End remain distinct key events", () => {
	const { input, events, terminal } = makeTTY();
	terminal.start();
	input.write("\x01\x05\x0b\x15\x17\x0c\x1b[1;5H\x1b[1;2F\x1b[107;5u");
	assert.deepEqual(events.filter((event) => event.type === "key").map((event) => [event.key, event.ctrl, event.shift]), [
		["ctrl-a", true, false],
		["ctrl-e", true, false],
		["ctrl-k", true, false],
		["ctrl-u", true, false],
		["ctrl-w", true, false],
		["ctrl-l", true, false],
		["home", true, false],
		["end", false, true],
		["ctrl-k", true, false],
	]);
	terminal.stop();
});

test("start and stop restore raw mode and bracketed paste exactly once", () => {
	const { input, outputText, terminal } = makeTTY();
	terminal.start();
	terminal.start();
	assert.equal(input.isRaw, true);
	assert.deepEqual(input.rawChanges, [true]);
	assert.equal(outputText(), "\x1b[?2004h");
	terminal.stop();
	terminal.stop();
	assert.equal(input.isRaw, false);
	assert.deepEqual(input.rawChanges, [true, false]);
	assert.equal(outputText(), "\x1b[?2004h\x1b[?2004l");

	const alreadyRaw = makeTTY(true);
	alreadyRaw.terminal.start();
	alreadyRaw.terminal.stop();
	assert.deepEqual(alreadyRaw.input.rawChanges, [true, true]);
});

test("redirected stdout is not polluted by bracketed-paste control codes", () => {
	const input = new FakeTTY();
	const output = new PassThrough();
	let written = "";
	output.on("data", (chunk: Buffer) => { written += chunk.toString(); });
	const terminal = new TerminalInput({ input, output, onEvent: () => {} });
	terminal.start();
	terminal.stop();
	assert.equal(written, "");
	assert.deepEqual(input.rawChanges, [true, false]);
});

test("non-TTY input becomes one paste at EOF without synthesizing Enter", async () => {
	const input = new PassThrough();
	const output = new PassThrough();
	const events: TerminalInputEvent[] = [];
	const terminal = new TerminalInput({ input, output, onEvent: (event) => events.push(event) });
	terminal.start();
	input.write("first\r\nsecond\n");
	assert.deepEqual(events, []);
	input.end("third");
	await once(input, "end");
	assert.deepEqual(events, [
		{ type: "paste", text: "first\nsecond\nthird" },
		{ type: "end" },
	]);
});
