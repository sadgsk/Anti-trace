import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import { test } from "node:test";
import { createElement } from "react";
import { render } from "ink";
import stringWidth from "string-width";
import { CommandMenu } from "../../src/tui/suggestions/CommandMenu.tsx";
import { SLASH_COMMANDS } from "../../src/cli/commands/command-registry.ts";
import type { PromptSuggestionsSnapshot } from "../../src/tui/suggestions/prompt-suggestions-controller.ts";

class Output extends Writable {
	columns = 120;
	rows = 40;
	isTTY = false;
	frames: string[] = [];
	_write(chunk: Buffer, _encoding: string, callback: () => void) { this.frames.push(chunk.toString()); callback(); }
}
const pause = () => new Promise(resolve => setTimeout(resolve, 70));
const state = (selectedIndex = 0, items: PromptSuggestionsSnapshot["items"] = SLASH_COMMANDS): PromptSuggestionsSnapshot => ({ open: true, items, selectedIndex });

async function renderMenu(snapshot: PromptSuggestionsSnapshot, columns: number, rows: number) {
	const stdout = new Output();
	stdout.columns = columns;
	const stdin = new PassThrough();
	const app = render(createElement(CommandMenu, { state: snapshot, availableColumns: columns, availableRows: rows }), {
		stdout: stdout as unknown as NodeJS.WriteStream, stdin: stdin as unknown as NodeJS.ReadStream,
		debug: true, patchConsole: false, exitOnCtrlC: false,
	});
	try {
		await pause();
		return (stdout.frames.at(-1) ?? "").replace(/\x1b\[[0-9;]*m/g, "");
	} finally { app.unmount(); app.cleanup(); stdin.destroy(); stdout.destroy(); }
}

test("P09 shows six commands, required arguments, overflow, shortcuts and a counter", async () => {
	const frame = await renderMenu(state(), 100, 16);
	assert.match(frame, /❯ \/help/);
	for (const name of ["new", "resume", "model", "thinking", "effort"]) assert.match(frame, new RegExp(`/${name}`));
	assert.doesNotMatch(frame, /\/exit/);
	assert.match(frame, /\/model.*打开模型选择/); assert.doesNotMatch(frame, /\[需参数\]/);
	assert.match(frame, /还有 8 条/);
	assert.match(frame, /↑↓ 选择  Enter 确认  Tab 补全  Esc 收起.*1\/14/);
	assert.match(frame, /╭/);
	assert.match(frame, /│❯.*│/);
});

test("scrolling keeps the last selected command visible with its global position", async () => {
	const frame = await renderMenu(state(13), 80, 12);
	assert.match(frame, /❯ \/exit/);
	assert.doesNotMatch(frame, /\/help/);
	assert.match(frame, /上方 8 条 · 下方 0 条/);
	assert.match(frame, /14\/14/);
});

test("filtered commands remove the overflow hint and required parameters retain their badge", async () => {
	const filtered = await renderMenu(state(0, SLASH_COMMANDS.filter(command => command.name.startsWith("con"))), 80, 12);
	assert.match(filtered, /❯ \/context/);
	assert.match(filtered, /1\/2/);
	assert.doesNotMatch(filtered, /还有|上方|\/help/);
	const required = await renderMenu(state(0, [SLASH_COMMANDS[3]]), 28, 5);
	assert.match(required, /❯ \/model/); assert.doesNotMatch(required, /\[需参数\]/);
});

test("empty results retain the dismiss action and render a zero counter", async () => {
	const frame = await renderMenu(state(0, []), 80, 12);
	assert.match(frame, /无匹配命令/);
	assert.match(frame, /Esc 收起.*0\/0/);
	assert.doesNotMatch(frame, /Enter|❯/);
});

test("rendered output fits both dimensions from tiny terminals to wide screens", async () => {
	for (const columns of [1, 5, 20, 39, 40, 80, 120]) {
		for (const rows of [1, 2, 6, 7, 12]) {
			const frame = await renderMenu(state(13), columns, rows);
			assert.ok(frame.split("\n").length <= rows, `${columns}×${rows}: height ${frame.split("\n").length}`);
			for (const line of frame.split("\n")) assert.ok(stringWidth(line) <= columns, `${columns}×${rows}: ${line}`);
			assert.match(frame, /❯/, `${columns}×${rows}: selected item disappeared`);
			if (columns >= 20) assert.match(frame, /\/exit/);
			if (rows >= 2 && columns >= 5) assert.match(frame, /14\/14/);
		}
	}
});

test("changing selection does not change the row count or panel width", async () => {
	for (const index of [0, 3, 5, 8, 11]) {
		const frame = await renderMenu(state(index), 80, 12);
		assert.equal(frame.split("\n").length, 12);
		assert.equal(frame.split("\n").filter(line => line.includes("❯")).length, 1);
	}
});

test("closed or zero-sized viewports produce no output", async () => {
	for (const [snapshot, columns, rows] of [[{ ...state(), open: false }, 80, 12], [state(), 0, 12], [state(), 80, 0]] as const) {
		assert.equal(await renderMenu(snapshot, columns, rows), "");
	}
});

test("CJK and emoji descriptions are truncated without broken graphemes", async () => {
	const frame = await renderMenu(state(0, [{ name: "review", description: "检查👩‍💻实现与架构边界".repeat(8) }]), 40, 10);
	assert.ok(frame.includes("…"));
	assert.doesNotMatch(frame, /�/);
	for (const line of frame.split("\n")) assert.ok(stringWidth(line) <= 40);
});
