import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PasteHandler, type PasteHandlerOptions } from "../src/cli/input/paste-handler.ts";
import { TextInputController } from "../src/cli/input/text-input-controller.ts";
import { createTextInputState } from "../src/cli/input/text-input-state.ts";
import { InputDispatcher } from "../src/cli/input/input-dispatcher.ts";
import { DEFAULT_KEYBINDINGS } from "../src/cli/input/keybindings.ts";
import { TerminalInputParser } from "../src/cli/ink/terminal-input.ts";
import type { PastedImage } from "../src/cli/utils/image-paste.ts";

const paste = (text: string) => ({ type: "paste" as const, text, isPasted: true as const });
const text = (text: string) => ({ type: "text" as const, text });
const settled = () => new Promise<void>(resolve => setImmediate(resolve));
const image = (sourcePath: string): PastedImage => ({
	image: { type: "image", mimeType: "image/png", data: "fixture" }, sourcePath,
});
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>(done => { resolve = done; });
	return { promise, resolve };
}
function makeHandler(t: TestContext, options: Partial<PasteHandlerOptions> = {}) {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const received: string[] = [];
	const pending: boolean[] = [];
	const handler = new PasteHandler({
		onInput: event => received.push(`input:${event.type === "key" ? event.name : event.text}`),
		onPaste: value => received.push(`paste:${value}`),
		onPendingChange: value => pending.push(value), ...options,
	});
	t.after(() => handler.dispose());
	return { handler, received, pending };
}

test("ordinary input stays synchronous; marked paste merges until 100 ms of silence", t => {
	const { handler, received, pending } = makeHandler(t);
	handler.handleInput(text("normal"));
	handler.handleInput(paste("first\r\n\t"));
	assert.equal(handler.isPending(), true);
	t.mock.timers.tick(99);
	assert.deepEqual(received, ["input:normal"]);
	handler.handleInput(text("continuation[I"));
	t.mock.timers.tick(99);
	assert.deepEqual(received, ["input:normal"]);
	t.mock.timers.tick(1);
	assert.deepEqual(received, ["input:normal", "paste:first\r\n\tcontinuation[I"]);
	assert.deepEqual(pending, [true, false]);
});

test("the fallback threshold is strictly greater than 800, including unmarked continuations", t => {
	const { handler, received } = makeHandler(t);
	handler.handleInput(text("a".repeat(800)));
	assert.equal(handler.isPending(), false);
	handler.handleInput(text("b".repeat(801)));
	handler.handleInput(text("tail"));
	assert.equal(handler.isPending(), true);
	t.mock.timers.tick(100);
	assert.deepEqual(received, [`input:${"a".repeat(800)}`, `paste:${"b".repeat(801)}tail`]);
});

test("image paths enter the buffer but remain exact text without an image consumer", t => {
	let reads = 0;
	const { handler, received } = makeHandler(t, { readImage: async () => { reads++; return image("x"); } });
	handler.handleInput(text("'/tmp/a b.png'\r\n/missing.jpg\t"));
	assert.equal(handler.isPending(), true);
	t.mock.timers.tick(100);
	assert.deepEqual(received, ["paste:'/tmp/a b.png'\r\n/missing.jpg\t"]);
	assert.equal(reads, 0);
});

test("mixed successful and failed paths preserve their original order and every remaining byte", async t => {
	const received: string[] = [];
	const { handler } = makeHandler(t, {
		onPaste: value => received.push(value),
		onImagePaste: value => received.push(`[${value.sourcePath}]`),
		readImage: async path => path === "/tmp/ok.png" ? image(path) : null,
	});
	handler.handleInput(paste("before\r\n/tmp/ok.png\t/tmp/missing.jpg\nafter"));
	t.mock.timers.tick(100);
	assert.equal(handler.isPending(), true);
	await settled();
	assert.deepEqual(received, ["before\r\n", "[/tmp/ok.png]", "\t/tmp/missing.jpg\nafter"]);
	assert.equal(handler.isPending(), false);
});

test("a real truncated PNG path stays in the pasted text instead of becoming an attachment", async t => {
	const directory = await mkdtemp(join(tmpdir(), "anti-trace-bad-paste-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const path = join(directory, "broken.png");
	await writeFile(path, Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"));
	let done!: () => void;
	const delivered = new Promise<void>(resolve => { done = resolve; });
	const { handler, received } = makeHandler(t, {
		onImagePaste: () => assert.fail("truncated image"),
		onPendingChange: pending => { if (!pending) done(); },
	});
	const source = `describe '${path}'\r\n`;
	handler.handleInput(paste(source));
	t.mock.timers.tick(100);
	await delivered;
	assert.deepEqual(received, [`paste:${source}`]);
	assert.equal(handler.isPending(), false);
});

test("async image batches, editing and following text are delivered in event order", async t => {
	const first = deferred<PastedImage | null>();
	const received: string[] = [];
	const { handler } = makeHandler(t, {
		onPaste: value => received.push(value),
		onImagePaste: value => received.push(value.sourcePath!),
		readImage: path => path === "/a.png" ? first.promise : Promise.resolve(image(path)),
	});
	handler.handleInput(paste("/a.png"));
	t.mock.timers.tick(100);
	handler.handleInput(paste("/b.png"));
	handler.runAfterPaste(() => received.push("left"));
	handler.handleInput(text("tail"));
	t.mock.timers.tick(100);
	await settled();
	assert.deepEqual(received, []);
	first.resolve(image("/a.png"));
	await settled();
	assert.deepEqual(received, ["/a.png", "/b.png", "left", "tail"]);
	assert.equal(handler.isPending(), false);
});

test("macOS empty paste and missing temporary screenshots await the clipboard", async t => {
	const clipboard = deferred<PastedImage | null>();
	const received: string[] = [];
	let reads = 0;
	const { handler } = makeHandler(t, {
		platform: "darwin", onImagePaste: value => received.push(value.sourcePath!),
		readClipboard: () => { reads++; return clipboard.promise; },
		readImage: async () => null,
	});
	handler.handleInput(paste(""));
	t.mock.timers.tick(100);
	assert.equal(handler.isPending(), true);
	clipboard.resolve(image("clipboard"));
	await settled();
	assert.deepEqual(received, ["clipboard"]);
	handler.handleInput(paste("/private/TemporaryItems/screencaptureui.test/Screenshot.png"));
	t.mock.timers.tick(100);
	await settled();
	assert.equal(reads, 2);
	assert.deepEqual(received, ["clipboard", "clipboard"]);
});

test("empty paste on other platforms stays a text paste; failed clipboard reads release pending", async t => {
	let reads = 0;
	const { handler, received } = makeHandler(t, {
		platform: "linux", onImagePaste: () => assert.fail("no image"),
		readClipboard: async () => { reads++; throw new Error("not available"); },
	});
	handler.handleInput(paste(""));
	t.mock.timers.tick(100);
	assert.deepEqual(received, ["paste:"]);
	assert.equal(reads, 0);
	handler.pasteClipboard();
	assert.equal(handler.isPending(), true);
	await settled();
	assert.equal(reads, 1);
	assert.equal(handler.isPending(), false);
});

test("an empty macOS image paste cannot be merged away by immediately typed text", async t => {
	const clipboard = deferred<PastedImage | null>();
	const received: string[] = [];
	const { handler } = makeHandler(t, {
		platform: "darwin", readClipboard: () => clipboard.promise,
		onImagePaste: () => received.push("image"), onPaste: value => received.push(value),
	});
	handler.handleInput(paste(""));
	handler.handleInput(text("caption"));
	t.mock.timers.tick(100);
	clipboard.resolve(image("clipboard"));
	await settled();
	assert.deepEqual(received, ["image", "caption"]);
	assert.equal(handler.isPending(), false);
});

test("cancel and dispose invalidate timers and late readers without blocking a fresh draft", async t => {
	const old = deferred<PastedImage | null>();
	const { handler, received } = makeHandler(t, {
		onImagePaste: () => assert.fail("stale image"), readImage: () => old.promise,
	});
	handler.handleInput(paste("/old.png"));
	t.mock.timers.tick(100);
	handler.cancel();
	handler.handleInput(text("fresh"));
	old.resolve(image("/old.png"));
	await settled();
	assert.deepEqual(received, ["input:fresh"]);
	handler.handleInput(paste("cancelled timer"));
	handler.dispose();
	handler.dispose();
	t.mock.timers.tick(100);
	handler.handleInput(text("ignored"));
	assert.deepEqual(received, ["input:fresh"]);
	assert.equal(handler.isPending(), false);
});

test("a cancelled screenshot read cannot start another clipboard operation", async t => {
	const screenshot = deferred<PastedImage | null>();
	let clipboardReads = 0;
	const { handler } = makeHandler(t, {
		platform: "darwin", onImagePaste: () => assert.fail("stale image"),
		readImage: () => screenshot.promise,
		readClipboard: async () => { clipboardReads++; return image("clipboard"); },
	});
	handler.handleInput(paste("/private/TemporaryItems/screencaptureui.test/Screenshot.png"));
	t.mock.timers.tick(100);
	handler.dispose();
	screenshot.resolve(null);
	await settled();
	assert.equal(clipboardReads, 0);
});

test("a delivery callback can cancel the remaining image/text results", async t => {
	const received: string[] = [];
	const { handler } = makeHandler(t, {
		onPaste: value => { received.push(value); handler.cancel(); },
		onImagePaste: () => assert.fail("cancelled image"), readImage: async path => image(path),
	});
	handler.handleInput(paste("prefix /a.png tail"));
	t.mock.timers.tick(100);
	await settled();
	assert.deepEqual(received, ["prefix "]);
	assert.equal(handler.isPending(), false);
});

test("delivery exceptions report once, discard queued work and clear pending", async t => {
	const errors: unknown[] = [];
	const { handler } = makeHandler(t, {
		onPaste: () => { throw new Error("delivery failed"); }, onError: error => errors.push(error),
	});
	handler.handleInput(paste("text"));
	t.mock.timers.tick(100);
	assert.equal(errors.length, 1);
	assert.equal(handler.isPending(), false);
	handler.handleInput(paste("/a.png"));
	// No consumer means file-looking text follows the same error path.
	t.mock.timers.tick(100);
	assert.equal(errors.length, 2);
	await settled();
});

test("a throwing pending subscriber cannot prevent the delivery error handler from running", t => {
	const errors: unknown[] = [];
	const { handler } = makeHandler(t, {
		onPaste: () => { throw new Error("delivery"); },
		onPendingChange: pending => { if (!pending) throw new Error("subscriber"); },
		onError: error => errors.push(error),
	});
	handler.handleInput(paste("text"));
	t.mock.timers.tick(100);
	assert.equal(errors.length, 1);
	assert.ok(errors[0] instanceof AggregateError);
	assert.equal(handler.isPending(), false);
});

test("same-batch paste plus Enter is dropped; editing flushes before moving the cursor", t => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const submitted: string[] = [];
	const controller = new TextInputController({ availableColumns: 20,
		initialState: createTextInputState("AZ", 1), onSubmit: state => submitted.push(state.text) });
	t.after(() => controller.dispose());
	const parser = new TerminalInputParser();
	const dispatcher = new InputDispatcher();
	dispatcher.configure([controller.target]);
	const feed = (bytes: string) => parser.feed(Buffer.from(bytes)).forEach(event => dispatcher.dispatch(event));
	feed("\x1b[200~hello\n\t\x1b[201~\r");
	assert.equal(controller.getSnapshot().isPasting, true);
	assert.deepEqual(submitted, []);
	feed("\x1b[D!");
	assert.deepEqual(controller.getState(), createTextInputState("Ahello\n!\tZ", 8));
	assert.equal(controller.getSnapshot().isPasting, false);
	t.mock.timers.tick(100);
	assert.deepEqual(submitted, []);
	feed("\r");
	assert.deepEqual(submitted, ["Ahello\n!\tZ"]);
});

test("async image delivery gates Enter, allows image shortcut rebinding, and never auto-submits", async t => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const clipboard = deferred<PastedImage | null>();
	const submitted: string[] = [];
	const controller = new TextInputController({
		availableColumns: 20, pasteOptions: { readClipboard: () => clipboard.promise },
		onImagePaste: () => controller.insertText("[image]"), onSubmit: state => submitted.push(state.text),
	});
	t.after(() => controller.dispose());
	const dispatcher = new InputDispatcher();
	dispatcher.configure([controller.target], [...DEFAULT_KEYBINDINGS,
		{ context: "Input", chord: [{ name: "g", ctrl: true }], action: "input:paste-image" }]);
	const parser = new TerminalInputParser();
	const feed = (bytes: string) => parser.feed(Buffer.from(bytes)).forEach(event => dispatcher.dispatch(event));
	feed("\x07\r");
	assert.equal(controller.getSnapshot().isPasting, true);
	feed("\x1b[13;2u" + "after");
	t.mock.timers.tick(100);
	clipboard.resolve(image("clipboard"));
	await settled();
	assert.equal(controller.getState().text, "[image]\nafter");
	assert.deepEqual(submitted, []);
	feed("\r");
	assert.deepEqual(submitted, ["[image]\nafter"]);
});

test("the platform image shortcut uses exact modifiers and starts a clipboard read", async t => {
	let reads = 0;
	const controller = new TextInputController({ availableColumns: 20,
		onImagePaste: () => {}, pasteOptions: { readClipboard: async () => { reads++; return null; } } });
	t.after(() => controller.dispose());
	const dispatcher = new InputDispatcher();
	dispatcher.configure([controller.target]);
	const modifier = { ctrl: process.platform !== "win32", alt: process.platform === "win32", meta: false, shift: false };
	dispatcher.dispatch({ type: "key", name: "v", raw: "", ...modifier, shift: true });
	assert.equal(reads, 0);
	dispatcher.dispatch({ type: "key", name: "v", raw: "", ...modifier });
	assert.equal(reads, 1);
	assert.equal(controller.getSnapshot().isPasting, true);
	await settled();
	assert.equal(controller.getSnapshot().isPasting, false);
});

test("replacing the draft cancels in-flight images and all following old actions", async t => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const old = deferred<PastedImage | null>();
	const controller = new TextInputController({ availableColumns: 20,
		pasteOptions: { readImage: () => old.promise }, onImagePaste: () => assert.fail("old image") });
	t.after(() => controller.dispose());
	controller.handleInput(paste("/old.png"));
	t.mock.timers.tick(100);
	controller.handleAction("input:newline");
	controller.handleInput(text("old tail"));
	controller.replaceState(createTextInputState("new"));
	old.resolve(image("/old.png"));
	await settled();
	t.mock.timers.tick(100);
	assert.deepEqual(controller.getState(), createTextInputState("new"));
	assert.equal(controller.getSnapshot().isPasting, false);
});

test("a subscriber observing pending cleared by replacement only sees the new draft", t => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const submitted: string[] = [];
	const controller = new TextInputController({ availableColumns: 20,
		initialState: createTextInputState("old"), onSubmit: state => submitted.push(state.text) });
	t.after(() => controller.dispose());
	controller.subscribe(() => {
		if (!controller.getSnapshot().isPasting) controller.handleAction("input:submit");
	});
	controller.handleInput(paste("obsolete"));
	controller.replaceState(createTextInputState("new"));
	assert.deepEqual(submitted, ["new"]);
});
