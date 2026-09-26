import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import type { WriteStream } from "node:tty";
import { CliRenderer } from "../src/cli/input/cli-renderer.ts";

class Terminal extends EventEmitter {
	columns: number;
	rows: number;
	output = "";
	cursor = { row: 0, column: 0 };
	private cells: string[][] = [[]];

	constructor(columns = 40, rows = 24) {
		super();
		this.columns = columns;
		this.rows = rows;
	}

	write(value: string): boolean {
		this.output += value;
		for (let index = 0; index < value.length; ) {
			if (value[index] === "\x1b") {
				const match = /^\x1b\[(\d*)([ABCJ])/.exec(value.slice(index));
				assert.ok(match, "the renderer emitted an unexpected escape sequence");
				const amount = Number(match[1] || 1);
				switch (match[2]) {
					case "A":
						this.cursor.row = Math.max(0, this.cursor.row - amount);
						break;
					case "B":
						this.cursor.row = Math.min(this.rows - 1, this.cursor.row + amount);
						break;
					case "C":
						this.cursor.column += amount;
						break;
					case "J":
						this.cells[this.cursor.row] = (this.cells[this.cursor.row] ?? []).slice(0, this.cursor.column);
						this.cells.length = this.cursor.row + 1;
						break;
				}
				index += match[0].length;
				continue;
			}
			if (value[index] === "\r") {
				this.cursor.column = 0;
				index += 1;
				continue;
			}
			if (value[index] === "\n") {
				this.cursor.row += 1;
				this.cells[this.cursor.row] ??= [];
				index += 1;
				continue;
			}
			const codePoint = value.codePointAt(index) ?? 0;
			const character = String.fromCodePoint(codePoint);
			const width = codePoint >= 0x1100 && (codePoint <= 0x9fff || codePoint >= 0x1f000) ? 2 : 1;
			if (this.cursor.column + width > this.columns) {
				this.cursor.row += 1;
				this.cursor.column = 0;
			}
			this.cells[this.cursor.row] ??= [];
			this.cells[this.cursor.row][this.cursor.column] = character;
			if (width === 2) {
				this.cells[this.cursor.row][this.cursor.column + 1] = "";
			}
			this.cursor.column += width;
			index += character.length;
		}
		return true;
	}

	line(index: number): string {
		return (this.cells[index] ?? []).join("");
	}

	stream(): WriteStream {
		return this as unknown as WriteStream;
	}
}

test("draws a multiline draft and positions the cursor inside it", () => {
	const terminal = new Terminal();
	const renderer = new CliRenderer(terminal.stream());
	const text = "first\nsecond";
	renderer.show("you> ", text, "first\nse".length);
	assert.equal(terminal.line(0), "you> first");
	assert.equal(terminal.line(1), "second");
	assert.deepEqual(terminal.cursor, { row: 1, column: 2 });
	renderer.dispose();
});

test("redraw erases stale rows after deletion", () => {
	const terminal = new Terminal();
	const renderer = new CliRenderer(terminal.stream());
	renderer.show("you> ", "first\nsecond\nthird", 2);
	renderer.show("you> ", "short", 5);
	assert.equal(terminal.line(0), "you> short");
	assert.equal(terminal.line(1), "");
	assert.deepEqual(terminal.cursor, { row: 0, column: 10 });
	renderer.dispose();
});

test("wraps CJK and emoji as whole graphemes", () => {
	const terminal = new Terminal(8);
	const renderer = new CliRenderer(terminal.stream());
	renderer.show("you> ", "你🙂x", "你🙂x".length);
	assert.equal(terminal.line(0), "you> 你");
	assert.equal(terminal.line(1), "🙂x");
	assert.deepEqual(terminal.cursor, { row: 1, column: 3 });
	renderer.dispose();
});

test("places an exact-width draft on a fresh row when finished", () => {
	const terminal = new Terminal(8);
	const renderer = new CliRenderer(terminal.stream());
	renderer.show("you> ", "abc", 3);
	assert.equal(terminal.line(0), "you> abc");
	assert.deepEqual(terminal.cursor, { row: 1, column: 0 });
	renderer.finish();
	assert.deepEqual(terminal.cursor, { row: 1, column: 0 });
	renderer.dispose();
});

test("large drafts show a bounded viewport around the cursor", () => {
	const terminal = new Terminal(30, 6);
	const renderer = new CliRenderer(terminal.stream());
	const text = "a\nb\nc\nd\ne\nf";
	renderer.show("you> ", text, text.length);
	assert.match(terminal.line(0), /lines above/);
	assert.equal(terminal.line(1), "e");
	assert.equal(terminal.line(2), "f");
	assert.deepEqual(terminal.cursor, { row: 2, column: 1 });
	assert.ok(terminal.output.length < 100, "a large draft should not fill terminal scrollback");
	renderer.dispose();
});

test("print restores the draft; resize redraws it from a fresh anchor", () => {
	const terminal = new Terminal(20);
	const renderer = new CliRenderer(terminal.stream());
	renderer.show("you> ", "hello", 5);
	renderer.print("notice");
	assert.equal(terminal.line(0), "notice");
	assert.equal(terminal.line(1), "you> hello");
	terminal.columns = 8;
	terminal.emit("resize");
	assert.equal(terminal.line(1), "you> hello");
	assert.equal(terminal.line(24), "you> hel");
	assert.equal(terminal.line(25), "lo");
	renderer.dispose();
});

test("CRLF is a single newline and pasted control bytes cannot style the terminal", () => {
	const terminal = new Terminal();
	const renderer = new CliRenderer(terminal.stream());
	renderer.show("you> ", "a\r\nb\x1b[31m", 9);
	assert.equal(terminal.line(0), "you> a");
	assert.equal(terminal.line(1), "b^[[31m");
	assert.equal(terminal.output.includes("\x1b[31m"), false);
	renderer.dispose();
});
