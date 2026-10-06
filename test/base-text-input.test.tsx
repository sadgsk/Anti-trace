import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import { test } from "node:test";
import { render } from "ink";
import * as React from "react";
import { BaseTextInput } from "../src/cli/input/base-text-input.tsx";
import { TextInputController } from "../src/cli/input/text-input-controller.ts";
import { createTextInputState } from "../src/cli/input/text-input-state.ts";
import { startTerminalTextInput } from "../src/cli/input/terminal-text-input.tsx";
import type { TerminalStreams } from "../src/cli/ink/terminal-host.ts";
import type { PastedImage } from "../src/cli/utils/image-paste.ts";

class Output extends Writable {
	columns = 10;
	rows = 24;
	isTTY = false;
	frames: string[] = [];
	_write(chunk: Buffer, _encoding: string, callback: () => void) {
		this.frames.push(chunk.toString());
		callback();
	}
}

class Input extends PassThrough {
	isTTY = true;
	isRaw = false;
	setRawMode(value: boolean) { this.isRaw = value; return this; }
}

const nextFrame = () => new Promise(resolve => setTimeout(resolve, 70));
const stripStyles = (value: string) => value.replace(/\x1b\[[0-9;]*m/g, "");

test("Ink renders shared CJK/Tab rows and redraws synchronous edits and resizing", async () => {
	const stdout = new Output();
	const stdin = new PassThrough();
	const controller = new TextInputController({ availableColumns: 4,
		initialState: createTextInputState("你\t🙂x\n", 1) });
	const app = render(<BaseTextInput controller={controller} />, {
		stdout: stdout as unknown as NodeJS.WriteStream,
		stdin: stdin as unknown as NodeJS.ReadStream,
		debug: true, patchConsole: false, exitOnCtrlC: false,
	});
	try {
		await nextFrame();
		assert.equal(stripStyles(stdout.frames.at(-1)!), "你\n🙂x\n");
		controller.replaceState(createTextInputState("abcd🙂", 4));
		await nextFrame();
		assert.equal(stripStyles(stdout.frames.at(-1)!), "abcd\n🙂");
		controller.setAvailableColumns(8);
		await nextFrame();
		assert.equal(stripStyles(stdout.frames.at(-1)!), "abcd🙂");
	} finally { app.unmount(); app.cleanup(); stdin.destroy(); stdout.destroy(); }
});

test("Ink cursor projection keeps a complete emoji and expanded Tab spaces", async () => {
	const stdout = new Output();
	const stdin = new PassThrough();
	const controller = new TextInputController({ availableColumns: 8,
		initialState: createTextInputState("x👩‍💻\ty", 1) });
	const app = render(<BaseTextInput controller={controller} />, {
		stdout: stdout as unknown as NodeJS.WriteStream,
		stdin: stdin as unknown as NodeJS.ReadStream,
		debug: true, patchConsole: false, exitOnCtrlC: false,
	});
	try {
		await nextFrame();
		assert.equal(stripStyles(stdout.frames.at(-1)!), "x👩‍💻 y");
		controller.replaceState(createTextInputState("x\ty", 1));
		await nextFrame();
		assert.equal(stripStyles(stdout.frames.at(-1)!), "x   y");
	} finally { app.unmount(); app.cleanup(); stdin.destroy(); stdout.destroy(); }
});

test("display projection keeps controls, lone surrogates and zero-width clusters aligned", async () => {
	const stdout = new Output();
	const stdin = new PassThrough();
	const source = "\u0301\u200b\ud800\x1bA";
	const controller = new TextInputController({ availableColumns: 4,
		initialState: createTextInputState(source) });
	const app = render(<BaseTextInput controller={controller} />, {
		stdout: stdout as unknown as NodeJS.WriteStream,
		stdin: stdin as unknown as NodeJS.ReadStream,
		debug: true, patchConsole: false, exitOnCtrlC: false,
	});
	try {
		await nextFrame();
		assert.equal(stripStyles(stdout.frames.at(-1)!), "����\nA");
		assert.equal(controller.getState().text, source);
	} finally { app.unmount(); app.cleanup(); stdin.destroy(); stdout.destroy(); }
});

test("terminal adapter owns one stdin listener, submits fresh snapshots, resizes and cleans up", async () => {
	const stdin = new Input();
	const stdout = new Output();
	stdout.isTTY = true;
	let submitted = "";
	const baselineResize = stdout.listenerCount("resize");
	const input = startTerminalTextInput({ onSubmit: state => { submitted = state.text; } },
		{ stdin, stdout } as unknown as TerminalStreams);
	try {
		assert.equal(stdin.listenerCount("data"), 1);
		assert.equal(stdin.isRaw, true);
		stdin.write(Buffer.from("你好\x1b[D!\r"));
		assert.equal(submitted, "你!好");
		await nextFrame();
		assert.ok(stdout.frames.join("").includes("你!好"));
		stdout.columns = 5;
		stdout.emit("resize");
		assert.equal(input.controller.getSnapshot().availableColumns, 4);
		await nextFrame();
	} finally { input.stop(); stdin.destroy(); stdout.destroy(); }
	assert.equal(stdin.isRaw, false);
	assert.equal(stdin.listenerCount("data"), 0);
	assert.equal(stdout.listenerCount("resize"), baselineResize);
	assert.ok(stdout.frames.join("").includes("\x1b[?2004l"));
});

test("stopping from a submit callback drops the remainder of that terminal batch", () => {
	const stdin = new Input();
	const stdout = new Output();
	stdout.isTTY = true;
	const input = startTerminalTextInput({ onSubmit: () => input.stop() },
		{ stdin, stdout } as unknown as TerminalStreams);
	try {
		stdin.emit("data", Buffer.from("accepted\rignored"));
		assert.equal(input.controller.getState().text, "accepted");
		assert.equal(stdin.isRaw, false);
	} finally { input.stop(); stdin.destroy(); stdout.destroy(); }
});

test("a throwing input callback restores the terminal and detaches input listeners", () => {
	const stdin = new Input();
	const stdout = new Output();
	stdout.isTTY = true;
	const baselineResize = stdout.listenerCount("resize");
	const input = startTerminalTextInput({ onSubmit: () => { throw new Error("rejected"); } },
		{ stdin, stdout } as unknown as TerminalStreams);
	try {
		assert.throws(() => stdin.emit("data", Buffer.from("text\r")), /rejected/);
		assert.equal(stdin.isRaw, false);
		assert.equal(stdin.listenerCount("data"), 0);
		assert.equal(stdout.listenerCount("resize"), baselineResize);
	} finally { input.stop(); stdin.destroy(); stdout.destroy(); }
});

test("terminal stop and stdin EOF discard a buffered paste and restore terminal modes", async () => {
	for (const exit of ["stop", "end", "close"] as const) {
		const stdin = new Input();
		const stdout = new Output();
		stdout.isTTY = true;
		const pasted: string[] = [];
		const baselineResize = stdout.listenerCount("resize");
		const input = startTerminalTextInput({ onPaste: event => pasted.push(event.text) },
			{ stdin, stdout } as unknown as TerminalStreams);
		try {
			stdin.emit("data", Buffer.from("\x1b[200~discarded\x1b[201~"));
			assert.equal(input.controller.getSnapshot().isPasting, true);
			if (exit === "stop") input.stop();
			else stdin.emit(exit);
			await new Promise(resolve => setTimeout(resolve, 130));
			assert.deepEqual(pasted, [], exit);
			assert.equal(input.controller.getSnapshot().isPasting, false);
			assert.equal(stdin.isRaw, false);
			assert.equal(stdin.listenerCount("data"), 0);
			assert.equal(stdout.listenerCount("resize"), baselineResize);
		} finally { input.stop(); stdin.destroy(); stdout.destroy(); }
	}
});

test("async image callbacks are discarded after the terminal stops", async () => {
	const stdin = new Input();
	const stdout = new Output();
	stdout.isTTY = true;
	let resolveImage!: (image: PastedImage) => void;
	const pendingImage = new Promise<PastedImage>(resolve => { resolveImage = resolve; });
	let reads = 0;
	const input = startTerminalTextInput({
		pasteOptions: { readClipboard: () => { reads++; return pendingImage; } },
		onImagePaste: () => assert.fail("stale image"),
	}, { stdin, stdout } as unknown as TerminalStreams);
	try {
		input.controller.handleAction("input:paste-image");
		assert.equal(reads, 1);
		assert.equal(input.controller.getSnapshot().isPasting, true);
		input.stop();
		resolveImage({ image: { type: "image", mimeType: "image/png", data: "fixture" } });
		await new Promise(resolve => setImmediate(resolve));
		assert.equal(input.controller.getSnapshot().isPasting, false);
		assert.equal(stdin.isRaw, false);
	} finally { input.stop(); stdin.destroy(); stdout.destroy(); }
});

test("an asynchronous paste delivery error stops the host before reporting it", async () => {
	const stdin = new Input();
	const stdout = new Output();
	stdout.isTTY = true;
	const errors: unknown[] = [];
	const input = startTerminalTextInput({
		onPaste: () => { throw new Error("paste rejected"); },
		onPasteError: error => { assert.equal(stdin.isRaw, false); errors.push(error); },
	}, { stdin, stdout } as unknown as TerminalStreams);
	try {
		stdin.emit("data", Buffer.from("\x1b[200~text\x1b[201~"));
		await new Promise(resolve => setTimeout(resolve, 130));
		assert.equal(errors.length, 1);
		assert.equal(stdin.listenerCount("data"), 0);
		assert.equal(input.controller.getSnapshot().isPasting, false);
	} finally { input.stop(); stdin.destroy(); stdout.destroy(); }
});

test("stdin errors restore the host and cancel buffered paste before propagating", async () => {
	const stdin = new Input();
	const stdout = new Output();
	stdout.isTTY = true;
	const input = startTerminalTextInput({ onPaste: () => assert.fail("cancelled paste") },
		{ stdin, stdout } as unknown as TerminalStreams);
	try {
		stdin.emit("data", Buffer.from("\x1b[200~pending\x1b[201~"));
		assert.throws(() => stdin.emit("error", new Error("stdin failed")), /stdin failed/);
		assert.equal(stdin.isRaw, false);
		assert.equal(stdin.listenerCount("data"), 0);
		assert.equal(input.controller.getSnapshot().isPasting, false);
		await new Promise(resolve => setTimeout(resolve, 130));
	} finally { input.stop(); stdin.destroy(); stdout.destroy(); }
});
