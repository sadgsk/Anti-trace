import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, basename, resolve } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { createElement } from "react";
import { render } from "ink";
import stringWidth from "string-width";
import { createBashTool } from "../../src/harness/tools/bash.ts";
import { BashToolView } from "../../src/tui/tools/BashToolView.tsx";
import { toolText } from "../../src/tui/tools/tool-result.ts";
import type { ToolUseItem } from "../../src/tui/transcript.ts";
import { ScrollbackOutput } from "../../src/cli/ink/scrollback-output.ts";
import { buildDiff } from "../../src/harness/tools/diff.ts";
import { StructuredDiff } from "../../src/tui/diff/StructuredDiff.tsx";
const strip = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");
async function capture(item: ToolUseItem, columns: number, expanded = false) {
	const frames: string[] = [], stdin = new PassThrough(), stdout = new Writable({ write(chunk, _enc, done) { frames.push(chunk.toString()); done(); } });
	Object.assign(stdout, { columns, rows: 50, isTTY: false });
	const app = render(createElement(BashToolView, { item, columns, expanded }), { stdin: stdin as any, stdout: stdout as any, debug: true, patchConsole: false, exitOnCtrlC: false });
	try { await new Promise(resolve => setTimeout(resolve, 65)); return frames.at(-1) ?? ""; }
	finally { app.unmount(); app.cleanup(); stdin.destroy(); stdout.destroy(); }
}
function assertCard(frame: string, columns: number) {
	assert.doesNotMatch(frame, /\r/);
	const rows = strip(frame).split("\n").filter(Boolean);
	assert.ok(rows[0]?.startsWith("╭")); assert.ok(rows.at(-1)?.startsWith("╰"));
	for (const row of rows) { assert.equal(stringWidth(row), columns, row); assert.ok(/[│╮╯]$/.test(row), row); }
}
test("real Windows dir CRLF output stays inside a compact frame, including expanded results", { skip: process.platform !== "win32" }, async () => {
	const root = resolve(mkdtempSync(join(tmpdir(), "tool-frame-")));
	try {
		writeFileSync(join(root, "alpha.txt"), "alpha"); writeFileSync(join(root, "beta.ts"), "beta");
		const result = await createBashTool(root).execute("dir", { command: "dir" });
		assert.ok(result.content[0]?.type === "text" && result.content[0].text.includes("\r\n"), "fixture must exercise actual CMD CRLF output");
		const item: ToolUseItem = { id: 1, kind: "tool", callId: "dir", name: "bash", args: { command: "dir" }, status: "success", startedAt: 0, endedAt: 1000, result };
		assert.doesNotMatch(toolText(item), /\r/);
		for (const columns of [40, 80, 190]) {
			const collapsed = await capture(item, columns); assertCard(collapsed, columns); assert.ok(strip(collapsed).split("\n").length < 16);
			const expanded = await capture(item, columns, true); assertCard(expanded, columns); assert.match(expanded, /alpha\.txt/); assert.match(expanded, /beta\.ts/);
		}
	} finally { assert.equal(dirname(root), resolve(tmpdir())); assert.match(basename(root), /^tool-frame-/); rmSync(root, { recursive: true, force: true }); }
});
test("CRLF, carriage-return progress and tabs cannot become cursor controls inside tool cards", async () => {
	const raw = "第一行\r\nsecond\tcolumn\rprogress 10%\rprogress 90%\r\nlast\n";
	const item: ToolUseItem = { id: 1, kind: "tool", callId: "progress", name: "bash", args: { command: "progress" }, status: "success", startedAt: 0,
		result: { content: [{ type: "text", text: raw }], details: { exitCode: 0 } } };
	const frame = await capture(item, 80, true); assertCard(frame, 80); assert.match(frame, /progress 10%/); assert.match(frame, /progress 90%/); assert.equal(item.result!.content[0]?.type === "text" && item.result!.content[0].text, raw);
});
test("native frame transport explicitly resets columns for every row", () => {
	let output = "";
	const stdout = Object.assign(new Writable({ write(chunk, _enc, done) { output += chunk.toString(); done(); } }), { columns: 80, rows: 24 });
	const writer = new ScrollbackOutput(stdout as any);
	writer.write("╭─────╮\n│ one │\n╰─────╯\n"); writer.write("╭─────╮\n│ two │\n╰─────╯\n"); writer.finish();
	assert.doesNotMatch(output, /(?<!\r)\n/); assert.match(output, /│ two │/); stdout.destroy();
});
test("expanded CRLF diffs keep one display row per code line, including word highlights", async () => {
	const diff = buildDiff("file.ts", "const value = 1;\r\nnext();\r\n", "const value = 2;\r\nnext();\r\n");
	const frames: string[] = [], stdin = new PassThrough(), stdout = new Writable({ write(chunk, _enc, done) { frames.push(chunk.toString()); done(); } });
	Object.assign(stdout, { columns: 80, rows: 24, isTTY: false });
	const app = render(createElement(StructuredDiff, { hunks: diff.hunks, columns: 80 }), { stdin: stdin as any, stdout: stdout as any, debug: true, patchConsole: false, exitOnCtrlC: false });
	try {
		await new Promise(resolve => setTimeout(resolve, 65)); const frame = strip(frames.at(-1) ?? "");
		assert.doesNotMatch(frame, /\r/); const rows = frame.trimEnd().split("\n"); assert.equal(rows.length, 3); assert.ok(rows.every(row => row.trim())); assert.match(frame, /value = 1/); assert.match(frame, /value = 2/);
	} finally { app.unmount(); app.cleanup(); stdin.destroy(); stdout.destroy(); }
});
