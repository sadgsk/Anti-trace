import assert from "node:assert/strict";
import test from "node:test";
import { PassThrough } from "node:stream";
import type { WriteStream } from "node:tty";
import { CliPrompt } from "../src/cli/input/cli-prompt.ts";
import type { TerminalInputStream } from "../src/cli/input/terminal.ts";

function makeTerminal(): {
	input: PassThrough & TerminalInputStream;
	output: PassThrough & WriteStream;
	rawModes: boolean[];
} {
	const input = new PassThrough() as PassThrough & TerminalInputStream;
	const output = new PassThrough() as PassThrough & WriteStream;
	const rawModes: boolean[] = [];
	input.isTTY = true;
	input.isRaw = false;
	input.setRawMode = (mode) => {
		input.isRaw = mode;
		rawModes.push(mode);
	};
	output.isTTY = true;
	output.columns = 80;
	output.rows = 24;
	output.on("data", () => {});
	return { input, output, rawModes };
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

test("pasting the reported multiline code never submits before a separate Enter", async () => {
	const { input, output, rawModes } = makeTerminal();
	const prompt = new CliPrompt({ input, output });
	const code = [
		"**await** executeToolCallsSequential(",
		"                           currentContext,",
		"                           message,",
		"                           toolCalls,",
		"                           config,",
		"                           signal,",
		"                           emit,",
		"                       )",
		"",
	].join("\r\n");
	let settled = false;
	const result = prompt.read("you> ").then((value) => {
		settled = true;
		return value;
	});
	input.write("\x1b[200~" + code.slice(0, 50));
	input.write(code.slice(50) + "\x1b[201~");
	await delay(30);
	assert.equal(settled, false);
	input.write("\r");
	assert.deepEqual(await result, { type: "submit", text: code.replace(/\r\n/g, "\n") });
	assert.deepEqual(rawModes, [true, false]);
	prompt.dispose();
});

test("rapid unmarked multiline input is kept as a draft", async () => {
	const { input, output } = makeTerminal();
	const prompt = new CliPrompt({ input, output });
	let settled = false;
	const result = prompt.read("you> ").then((value) => {
		settled = true;
		return value;
	});
	input.write("first\rsecond\r");
	await delay(150);
	assert.equal(settled, false);
	input.write("\r");
	assert.deepEqual(await result, { type: "submit", text: "first\nsecond\n" });
	prompt.dispose();
});

test("a rapid unmarked paste with a one-character first line stays a draft", async () => {
	const { input, output } = makeTerminal();
	const prompt = new CliPrompt({ input, output });
	let settled = false;
	const result = prompt.read("you> ").then((value) => {
		settled = true;
		return value;
	});
	input.write("a\rsecond\r");
	await delay(150);
	assert.equal(settled, false);
	input.write("\r");
	assert.deepEqual(await result, { type: "submit", text: "a\nsecond\n" });
	prompt.dispose();
});

test("manual paste mode makes slow unmarked newlines safe", async () => {
	const { input, output } = makeTerminal();
	const prompt = new CliPrompt({ input, output });
	const result = prompt.read("you> ", { allowPasteMode: true });
	for (const character of "/paste") {
		input.write(character);
		await delay(12);
	}
	input.write("\r");
	await delay(12);
	input.write("a\r");
	await delay(30);
	input.write("b\r");
	await delay(30);
	input.write("\x04");
	await delay(10);
	input.write("\r");
	assert.deepEqual(await result, { type: "submit", text: "a\nb\n" });
	prompt.dispose();
});

test("non-TTY piped multiline input becomes one submission at EOF", async () => {
	const input = new PassThrough() as PassThrough & TerminalInputStream;
	const output = new PassThrough() as PassThrough & WriteStream;
	const prompt = new CliPrompt({ input, output });
	const result = prompt.read("you> ");
	input.end("alpha\nbeta\n");
	assert.deepEqual(await result, { type: "submit", text: "alpha\nbeta\n" });
	assert.deepEqual(await prompt.read("you> "), { type: "end" });
	prompt.dispose();
});

test("a TTY disconnect never submits an unfinished draft", async () => {
	const { input, output } = makeTerminal();
	const prompt = new CliPrompt({ input, output });
	const result = prompt.read("you> ");
	input.end("unsent draft");
	assert.deepEqual(await result, { type: "end" });
	prompt.dispose();
});
