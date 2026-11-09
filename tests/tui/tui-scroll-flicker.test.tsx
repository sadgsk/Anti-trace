import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { PassThrough, Writable } from "node:stream";
import { createElement } from "react";
import { render, Text } from "ink";
import stringWidth from "string-width";
import { Harness } from "../../src/harness/harness.ts";
import { ReplController } from "../../src/cli/repl/repl-controller.ts";
import { startTerminalRepl } from "../../src/cli/repl/terminal-repl.tsx";
import { PromptInputController } from "../../src/cli/input/prompt-input-controller.ts";
import { PromptSuggestionsController } from "../../src/tui/suggestions/prompt-suggestions-controller.ts";
import { ReplScreen } from "../../src/tui/layout/ReplScreen.tsx";
import { ScrollbackOutput } from "../../src/cli/ink/scrollback-output.ts";
import { startTerminalHost, type TerminalStreams } from "../../src/cli/ink/terminal-host.ts";
import { createFakeStreamFn } from "../support/fake-stream.ts";
import { tempWorkspace, waitFor } from "../support/fixtures.ts";

const pause = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms));
const strip = (text: string) => text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
class Input extends PassThrough { isTTY = true; isRaw = false; setRawMode(value: boolean) { this.isRaw = value; return this; } }

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
		assert.match(last, /WELCOME_MARK/, "the welcome header must be reachable");
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
		await waitFor(() => !app.repl.getSnapshot().busy && frame.includes("HISTORY_54") && frame.includes("Shift+Tab"), "latest transcript frame");
		const latest = frame;
		stdin.write("\x1b[<64;5;5M");
		await waitFor(() => frame !== latest && frame.includes("BEFORE_OVERSIZED_ROW"), "history review frame");
		assert.equal(app.repl.getSnapshot().scrollOffset, 3);
		const rows = strip(frame).split("\r\n");
		assert.match(rows[0] ?? "", /BEFORE_OVERSIZED_ROW/);
		assert.match(rows[2] ?? "", /HISTORY_00/, "the first record after the oversized row should stay visible");
		assert.match(rows[54] ?? "", /HISTORY_52/);
		assert.match(rows[1] ?? "", /1️⃣/);
		assert.ok(stringWidth(rows[1] ?? "") < stdout.columns, "the oversized row should fit the terminal");
		assert.match(rows[56] ?? "", /Type \/ for commands|输入 \/ 查看命令/);
		assert.match(rows[58] ?? "", /yolo · Shift\+Tab/);

		const review = frame;
		stdin.write("\x1b[<65;5;5M");
		await waitFor(() => frame !== review && frame.includes("HISTORY_54"), "restored latest transcript frame");
		assert.equal(app.repl.getSnapshot().scrollOffset, 0);
		assert.equal(app.repl.getSnapshot().viewingHistory, false);
	} finally { app.stop(); stdin.destroy(); stdout.destroy(); }
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
