import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { PassThrough, Writable } from "node:stream";
import { createElement } from "react";
import { render, Text } from "ink";
import stringWidth from "string-width";
import { Harness } from "../../src/harness/harness.ts";
import { AssistantMessageEventStream } from "../../src/llm/event-stream.ts";
import type { AssistantMessage } from "../../src/types.ts";
import { ReplController } from "../../src/cli/repl/repl-controller.ts";
import { startTerminalRepl } from "../../src/cli/repl/terminal-repl.tsx";
import { PromptInputController } from "../../src/cli/input/prompt-input-controller.ts";
import { PromptSuggestionsController } from "../../src/tui/suggestions/prompt-suggestions-controller.ts";
import { ReplScreen } from "../../src/tui/layout/ReplScreen.tsx";
import { ScrollbackOutput } from "../../src/cli/ink/scrollback-output.ts";
import { ReplyGraphics } from "../../src/cli/ink/reply-graphics.ts";
import { startTerminalHost, type TerminalStreams } from "../../src/cli/ink/terminal-host.ts";
import { createFakeStreamFn } from "../support/fake-stream.ts";
import { tempWorkspace, waitFor } from "../support/fixtures.ts";
import { TerminalScreen } from "../support/terminal-screen.ts";

const pause = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms));
const strip = (text: string) => text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
class Input extends PassThrough { isTTY = true; isRaw = false; setRawMode(value: boolean) { this.isRaw = value; return this; } }

test("the rail cell contains either a text nabla or a centered SIXEL tile, including after resize", () => {
	const graphics = new ReplyGraphics();
	const row = "   \x1b[97m∇──\x1b[39m  正文里的 ∇";
	assert.equal(graphics.paintJunction(row, 3), row);
	graphics.response("\x1b[?65;4;22c");
	for (const [width, height] of [[9, 18], [12, 24]] as const) {
		graphics.response(`\x1b[6;${height};${width}t`);
		const painted = graphics.paintJunction(row, 3);
		const tileStart = painted.indexOf("\x1b7");
		assert.equal(painted.slice(0, tileStart), row.replace("∇──", " ──"));
		assert.ok(painted.slice(tileStart).startsWith(`\x1b7\x1b[4G\x1bP0;1q"1;1;${width};${height}`));
		assert.equal(painted.split("\x1bP").length - 1, 1);
		assert.equal(graphics.paintJunction(painted, 3), painted);
		graphics.resize();
		assert.equal(graphics.paintJunction(row, 3), row);
	}
});

test("thinking animates until text starts and the completed reply keeps a single nabla junction", async t => {
	const oldTerm = process.env.TERM, oldNoColor = process.env.NO_COLOR;
	process.env.TERM = "xterm-256color"; delete process.env.NO_COLOR;
	t.after(() => {
		if (oldTerm === undefined) delete process.env.TERM; else process.env.TERM = oldTerm;
		if (oldNoColor === undefined) delete process.env.NO_COLOR; else process.env.NO_COLOR = oldNoColor;
	});
	const cwd = tempWorkspace(t), stream = new AssistantMessageEventStream();
	const harness = new Harness({ cwd, sessionsRoot: join(cwd, "sessions"), apiKey: "fake",
		model: { id: "fake", name: "fake", provider: "fake", baseUrl: "http://127.0.0.1:1", api: "openai-completions", contextWindow: 100000 },
		streamFn: () => stream });
	const stdin = new Input(), stdout = Object.assign(new PassThrough(), { isTTY: true, columns: 60, rows: 18 });
	const screen = new TerminalScreen(stdout.columns, stdout.rows);
	const tiles = new Set<string>();
	const graphicRows: string[] = [];
	let leakedToken = false;
	let centeredJunction = false;
	stdout.on("data", chunk => {
		const data = chunk.toString();
		for (const row of data.split(/\r?\n/)) {
			if (row.includes("Reply content") && row.includes('\x1b7\x1b[4G\x1bP0;1q"1;1;9;18')) centeredJunction = true;
			const tile = /\x1bP0;1q[\s\S]*?\x1b\\/.exec(row);
			if (tile?.[0].startsWith('\x1bP0;1q"1;1;18;18')) { tiles.add(tile[0]); graphicRows.push(row.slice(0, tile.index)); }
		}
		if (/[\ue600-\ue63b\ue700-\ue771]/.test(data)) leakedToken = true;
		screen.write(data);
	});
	const app = startTerminalRepl({ harness, cwd, permissionMode: "yolo", streams: { stdin, stdout } as unknown as TerminalStreams });
	const text = "Reply content";
	const message: AssistantMessage = { role: "assistant", model: "fake", timestamp: Date.now(), stopReason: "stop", content: [{ type: "text", text }] };
	try {
		stdin.write("hello\r");
		await waitFor(() => /∇─[▽◿⋈◺◹◸]\s+(?:思考中|Thinking)/i.test(screen.text), "thinking animation before the first delta");
		stdin.write("\x1b[?65;4;22c\x1b[6;18;9t\x1b]10;rgb:ffff/ffff/ffff\x1b\\\x1b]11;rgb:f4f4/efef/dcdc\x1b\\");
		await waitFor(() => tiles.size >= 3, "distinct graphic thinking frames");
		assert.ok(graphicRows.every(row => /思考中|Thinking/i.test(strip(row)) && row.endsWith("\x1b7\x1b[6G")));
		stream.push({ type: "start", partial: message });
		stream.push({ type: "text_start", contentIndex: 0, partial: message });
		stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message });
		await waitFor(() => centeredJunction && /^ +── +Reply content$/m.test(screen.text), "reply starts beside the graphic junction");
		const streamingCount = graphicRows.length;
		await pause(200);
		assert.equal(graphicRows.length, streamingCount);
		assert.equal(app.prompt.getDraft().text, "");
		assert.equal(leakedToken, false);
		stream.push({ type: "text_end", contentIndex: 0, content: text, partial: message });
		stream.push({ type: "done", reason: "stop", message }); stream.end();
		await waitFor(() => !app.repl.getSnapshot().busy && screen.text.includes(text), "completed reply");
		assert.match(screen.text, /^ *◇── +hello$/m);
		assert.doesNotMatch(screen.text, /^ *∇─/m, "a terminal ignoring conceal must not draw a second triangle");
		assert.doesNotMatch(screen.text, /[▽◿⋈◺◹◸✓✗]/);
		const count = graphicRows.length;
		await pause(200);
		assert.equal(graphicRows.length, count, "completed replies stop painting frames");
		stdin.write("\x1b[?65;22c");
		await waitFor(() => /^ *∇── +Reply content$/m.test(screen.text), "text junction after returning to character rendering");
		assert.equal(screen.text.match(/^ *∇─/gm)?.length, 1);
	} finally {
		stream.end(message); app.stop(); await app.done; await harness.close();
		stdin.destroy(); stdout.destroy(); screen.dispose();
	}
});

// future-issues No.2: wheel-scrolling up stopped at the first message and flickered over the welcome logo.
test("wheel scrolling reaches the welcome header and stays there instead of snapping back to the first message", async () => {
	const repl = new ReplController({ harness: { prompt: async () => {}, abort() {}, subscribe: () => () => {}, newSession() {}, listSessions: () => [], resumeAt: () => false, setContextWindow() {}, manualCompact: async () => "nothing-to-compact" as const, contextUsage: () => ({ used: 0, window: undefined }) }, interactive: true, cwd: "/WELCOME_MARK" });
	const prompt = new PromptInputController({ availableColumns: 90, canSubmit: () => false, onSubmit() {} });
	const suggestions = new PromptSuggestionsController(prompt, repl, { cwd: "/WELCOME_MARK" });
	for (let i = 0; i < 40; i++) repl.write(`Notice line ${String(i).padStart(2, "0")}`);
	const frames: string[] = [], stdin = new PassThrough(), stdout = new Writable({ write(chunk, _enc, done) { frames.push(chunk.toString()); done(); } });
	Object.assign(stdout, { columns: 100, rows: 28, isTTY: false });
	const app = render(createElement(ReplScreen, { repl, prompt, suggestions, cwd: "/WELCOME_MARK", columns: 99, rows: 28, nativeScrollback: true }), { stdin: stdin as any, stdout: stdout as any, debug: true, patchConsole: false, exitOnCtrlC: false });
	try {
		await pause();
		const offsets: number[] = [];
		for (let i = 0; i < 40; i++) { repl.scroll(3); await pause(5); offsets.push(repl.getSnapshot().scrollOffset); }
		await pause();
		const last = strip(frames.at(-1) ?? "");
		assert.match(last, /[\u2801-\u28ff]/, "the welcome header must be reachable");
		assert.match(last, /Notice line 00/);
		// Offsets only grow until the top is reached; a snap back to the first message would decrease them.
		for (let i = 1; i < offsets.length; i++) assert.ok(offsets[i]! >= offsets[i - 1]!, `offset went back at step ${i}: ${offsets.join(",")}`);
		// Once at the top, further wheel input must not change the frame (no oscillation).
		const settled = frames.length; repl.scroll(3); await pause(); repl.scroll(3); await pause();
		assert.ok(frames.slice(settled).every(frame => strip(frame) === last));
	} finally { app.unmount(); app.cleanup(); suggestions.dispose(); prompt.dispose(); repl.dispose(); stdin.destroy(); stdout.destroy(); }
});

test("wheel review keeps the rows after an oversized Markdown row visible", async t => {
	const cwd = tempWorkspace(t);
	// A long keycap emoji sequence survives Markdown's wrapping as an oversized row.
	// With 55 transcript rows visible, one wheel event brings it in as the second row.
	const markers = Array.from({ length: 55 }, (_, i) => `HISTORY_${String(i).padStart(2, "0")}`);
	const text = ["BEFORE_OVERSIZED_ROW", "1️⃣".repeat(100), ...markers].map(line => `- ${line}`).join("\n");
	const harness = new Harness({ cwd, sessionsRoot: join(cwd, "sessions"), apiKey: "fake",
		model: { id: "fake", name: "fake", provider: "fake", baseUrl: "http://127.0.0.1:1", api: "openai-completions", contextWindow: 100000 },
		streamFn: createFakeStreamFn([{ text }]) });
	const stdin = new Input(), stdout = Object.assign(new PassThrough(), { isTTY: true, columns: 190, rows: 60 });
	let frame = "";
	stdout.on("data", chunk => {
		const write = chunk.toString();
		if (write.startsWith("\x1b[?2026h")) frame = write;
	});
	const app = startTerminalRepl({ harness, cwd, permissionMode: "yolo", streams: { stdin, stdout } as unknown as TerminalStreams });
	try {
		stdin.write("Render a long response\r");
		await waitFor(() => !app.repl.getSnapshot().busy && frame.includes("HISTORY_54"), "latest transcript frame");
		const latest = frame;
		stdin.write("\x1b[<64;5;5M");
		await waitFor(() => frame !== latest && frame.includes("BEFORE_OVERSIZED_ROW"), "history review frame");
		assert.equal(app.repl.getSnapshot().scrollOffset, 3);
		const rows = strip(frame).split("\r\n");
		const before = rows.findIndex(row => row.includes("BEFORE_OVERSIZED_ROW"));
		const first = rows.findIndex(row => row.includes("HISTORY_00"));
		assert.ok(before >= 0 && first > before + 1);
		assert.ok(rows.slice(before + 1, first).some(row => row.includes("1️⃣")));
		assert.ok(rows.slice(before, first + 1).every(row => stringWidth(row) < stdout.columns));
		assert.match(rows[first + 48] ?? "", /HISTORY_48/);
		assert.doesNotMatch(rows.join("\n"), /Type \/ for commands|输入 \/ 查看命令|Shift\+Tab/);

		const review = frame;
		stdin.write("\x1b[<65;5;5M");
		await waitFor(() => frame !== review && frame.includes("HISTORY_54"), "restored latest transcript frame");
		assert.equal(app.repl.getSnapshot().scrollOffset, 0);
		assert.equal(app.repl.getSnapshot().viewingHistory, false);
	} finally { app.stop(); stdin.destroy(); stdout.destroy(); }
});

test("the terminal IME anchor follows the focused cell through wrapping, menus, and repaint", async t => {
	const cwd = tempWorkspace(t);
	const harness = new Harness({ cwd, sessionsRoot: join(cwd, "sessions"), apiKey: "local", streamFn: createFakeStreamFn([]),
		model: { id: "ime", name: "footer-model", provider: "fake", baseUrl: "http://127.0.0.1:1", api: "openai-completions", contextWindow: 10000 } });
	const stdin = new Input(), stdout = Object.assign(new PassThrough(), { isTTY: true, columns: 44, rows: 22 });
	const screen = new TerminalScreen(stdout.columns, stdout.rows);
	stdout.on("data", chunk => screen.write(chunk.toString()));
	const app = startTerminalRepl({ harness, cwd, streams: { stdin, stdout } as unknown as TerminalStreams });
	async function at(text: string, offset = 0) {
		await waitFor(() => {
			const rows = screen.text.split("\n"), row = rows.findIndex(line => line.includes(text));
			return screen.idle && row >= 0 && screen.cursor.row === row &&
				screen.cursor.column === stringWidth(rows[row]!.slice(0, rows[row]!.indexOf(text))) + offset;
		}, "physical IME cursor at " + text);
	}
	try {
		await at("> █", 2);
		for (const mode of ["default", "auto-edit", "yolo"]) {
			if (mode !== "default") stdin.write("\x1b[Z");
			await waitFor(() => {
				const rows = screen.text.split("\n"), prompt = rows.findIndex(line => line.includes("> █"));
				const axis = rows[prompt]?.indexOf(">") ?? -1;
				return axis >= 0 && rows[prompt + 2] === " ".repeat(axis) + mode.padEnd(stdout.columns - 1 - axis - "footer-model".length) + "footer-model";
			}, "prompt footer tracks " + mode);
		}
		stdin.write("你好🙂"); await at("你好🙂█", 6);
		stdin.write("\x1b[D"); await at("你好🙂", 4);
		app.prompt.textInput.replaceText("跨".repeat(19) + "续".repeat(11) + "\n尾行"); await at("尾行█", 4);
		stdin.write("\x1b[A"); await at("续".repeat(11), 4);
		app.prompt.textInput.replaceText("/hel"); await at("/hel█", 4);
		for (let i = 0; i < 22; i++) app.repl.write("history line " + i);
		app.prompt.reset(); await at("> █", 2);
		assert.ok(screen.text.includes("footer-model"));
		stdout.columns = 82; screen.resize(82, stdout.rows); stdout.emit("resize");
		stdin.write("中文"); await at("中文█", 4);
		app.repl.dialogs.openInput({ title: "反馈", value: "意见", onAccept() {}, onBack: () => app.repl.dialogs.close() });
		await at("意见", 4);
		app.repl.dialogs.close(); await at("中文█", 4);
	} finally { app.stop(); await app.done; await harness.close(); stdin.destroy(); stdout.destroy(); screen.dispose(); }
});

test("native frame transport overwrites rows in place inside one synchronized update", () => {
	const writes: string[] = [];
	const stdout = Object.assign(new Writable({ write(chunk, _enc, done) { writes.push(chunk.toString()); done(); } }), { columns: 80, rows: 10 });
	const writer = new ScrollbackOutput(stdout as any);
	writer.write(["alpha", "beta", "gamma", "delta"].join("\n"));
	for (const change of [() => {}, () => writer.invalidate()]) {
		change(); writer.write(["alpha", "BETA", "gamma", "delta"].join("\n"));
		const out = writes.at(-1)!;
		assert.ok(out.startsWith("\x1b[?2026h") && out.endsWith("\x1b[?2026l"), JSON.stringify(out));
		// Erasing before the rows would blank the screen until they arrive.
		assert.ok(out.indexOf("\x1b[J") > out.lastIndexOf("delta"), JSON.stringify(out));
		assert.doesNotMatch(out, /(?<!\r)\n/);
		writer.write(["alpha", "beta", "gamma", "delta"].join("\n"));
	}
	stdout.destroy();
});

test("incremental terminal repaints retain unchanged tool preview rows on screen", async () => {
	const screen = new TerminalScreen(80, 10), writes: string[] = [];
	const stdout = Object.assign(new Writable({ write(chunk, _enc, done) {
		const data = chunk.toString(); writes.push(data); screen.write(data); done();
	} }), { columns: 80, rows: 10 });
	const writer = new ScrollbackOutput(stdout as any);
	try {
		writer.write("OLDER_00\nOLDER_01\nexpanded");
		await waitFor(() => screen.idle, "initial terminal output parsed");
		writer.write("OLDER_00\nOLDER_01\ncollapsed");
		await waitFor(() => screen.idle, "incremental terminal output parsed");
		assert.doesNotMatch(writes.at(-1)!, /OLDER_00/, "an unchanged row need not be sent again");
		assert.match(screen.text, /OLDER_00\nOLDER_01\ncollapsed/);
		assert.doesNotMatch(screen.text, /expanded/);
	} finally { stdout.destroy(); screen.dispose(); }
});

test("terminal host paints only the latest of several frames committed in one tick", async () => {
	class Output extends PassThrough { isTTY = true; columns = 80; rows = 24; }
	const stdin = new Input(), stdout = new Output(); let output = "";
	stdout.on("data", chunk => { output += chunk.toString(); });
	const host = startTerminalHost(() => {}, { stdin, stdout } as unknown as TerminalStreams, undefined, { scrollback: true });
	try {
		host.rerender(createElement(Text, null, "STALE FRAME"));
		host.rerender(createElement(Text, null, "LATEST FRAME"));
		await pause(50);
		assert.match(output, /LATEST FRAME/);
		assert.doesNotMatch(output, /STALE FRAME/);
	} finally { host.stop(); }
	assert.match(output, /\x1b\[\?2004l/);
});
