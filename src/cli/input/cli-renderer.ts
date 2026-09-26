import type { WriteStream } from "node:tty";

type Position = { row: number; column: number };

type Layout = {
	output: string;
	cursor: Position;
	end: Position;
};

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const emoji = /\p{Extended_Pictographic}|\p{Regional_Indicator}/u;
const combining = /\p{Mark}/u;

function isFullwidth(codePoint: number): boolean {
	return (
		codePoint >= 0x1100 &&
		(codePoint <= 0x115f ||
			codePoint === 0x2329 ||
			codePoint === 0x232a ||
			(codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
			(codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
			(codePoint >= 0xf900 && codePoint <= 0xfaff) ||
			(codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
			(codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
			(codePoint >= 0xff00 && codePoint <= 0xff60) ||
			(codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
			(codePoint >= 0x20000 && codePoint <= 0x3fffd))
	);
}

function graphemeWidth(grapheme: string): number {
	if (emoji.test(grapheme) || grapheme.includes("\u20e3") || grapheme.includes("\ufe0f")) {
		return 2;
	}
	for (const character of grapheme) {
		if (combining.test(character) || character === "\u200d" || character === "\ufe0e" || character === "\ufe0f") {
			continue;
		}
		return isFullwidth(character.codePointAt(0) ?? 0) ? 2 : 1;
	}
	return 1;
}

function displayGrapheme(grapheme: string): { text: string; width: number } {
	if (grapheme === "\t") {
		throw new Error("Tabs need the current column to determine their width");
	}
	if (grapheme.length === 1) {
		const code = grapheme.charCodeAt(0);
		if (code < 0x20 || code === 0x7f) {
			return { text: `^${String.fromCharCode(code === 0x7f ? 0x3f : code + 0x40)}`, width: 2 };
		}
		if (code >= 0x80 && code <= 0x9f) {
			return { text: "�", width: 1 };
		}
	}
	return { text: grapheme, width: graphemeWidth(grapheme) };
}

function layoutDraft(prompt: string, text: string, cursorUtf16: number, columns: number, screenRows: number): Layout {
	const width = Math.max(2, Math.floor(columns) || 80);
	const boundedCursor = Math.max(0, Math.min(text.length, Math.floor(cursorUtf16) || 0));
	let row = 0;
	let column = 0;
	const lines = [""];
	let cursor: Position = { row: 0, column: 0 };

	function position(): Position {
		// A full row has a pending terminal autowrap. Its next insertion point
		// is the beginning of the following row.
		return column === width ? { row: row + 1, column: 0 } : { row, column };
	}

	function newline(): void {
		row += 1;
		column = 0;
		lines.push("");
	}

	function appendVisible(value: string, cellWidth: number): void {
		if (column + cellWidth > width) {
			newline();
		}
		lines[row] += value;
		column += cellWidth;
	}

	function append(grapheme: string): void {
		if (grapheme === "\n" || grapheme === "\r\n") {
			newline();
			return;
		}
		if (grapheme === "\t") {
			const spaces = 8 - (column % 8);
			for (let index = 0; index < spaces; index += 1) {
				appendVisible(" ", 1);
			}
			return;
		}
		const display = displayGrapheme(grapheme);
		appendVisible(display.text, display.width);
	}

	for (const part of segmenter.segment(prompt)) {
		append(part.segment);
	}
	cursor = position();
	for (const part of segmenter.segment(text)) {
		const end = part.index + part.segment.length;
		const before = position();
		append(part.segment);
		if (boundedCursor >= end) {
			cursor = position();
		} else if (boundedCursor > part.index && boundedCursor < end) {
			// The editor normally supplies a grapheme boundary. If it does not,
			// keep the terminal cursor before the complete grapheme.
			cursor = before;
		}
	}
	if (column === width) {
		// Materialize the last wrap so moving the cursor to the end is reliable.
		newline();
	}
	const maxRows = Math.max(3, (Math.floor(screenRows) || 24) - 2);
	if (lines.length <= maxRows) {
		return { output: lines.join("\r\n"), cursor, end: { row, column } };
	}

	// Keep a bounded viewport around the insertion point. The draft remains
	// complete in the input model; only the temporary CLI view is clipped.
	const contentRows = maxRows - 2;
	const start = Math.max(0, Math.min(lines.length - contentRows, cursor.row - Math.floor(contentRows / 2)));
	const stop = start + contentRows;
	const topMarker = start > 0 ? [`... ${start} lines above`.slice(0, width - 1)] : [];
	const bottomMarker = stop < lines.length ? [`... ${lines.length - stop} lines below`.slice(0, width - 1)] : [];
	const visible = [...topMarker, ...lines.slice(start, stop), ...bottomMarker];
	return {
		output: visible.join("\r\n"),
		cursor: { row: cursor.row - start + topMarker.length, column: cursor.column },
		end: { row: visible.length - 1, column: bottomMarker.length > 0 ? bottomMarker[0].length : column },
	};
}

/** The temporary CLI view of a reusable multiline input draft. */
export class CliRenderer {
	private active = false;
	private prompt = "";
	private text = "";
	private cursorUtf16 = 0;
	private cursorRow = 0;
	private endRow = 0;
	private endColumn = 0;
	private disposed = false;

	private readonly onResize = (): void => {
		if (this.active && !this.disposed) {
			// Terminals may reflow already-painted rows when their width changes.
			// The old cursor row is no longer a safe erase anchor. Start a fresh
			// prompt below the old one; the future TUI can redraw the full screen.
			this.active = false;
			this.output.write("\x1b[999B\r\n");
			this.show(this.prompt, this.text, this.cursorUtf16);
		}
	};

	constructor(private readonly output: WriteStream) {
		this.output.on("resize", this.onResize);
	}

	show(prompt: string, text: string, cursorUtf16: number): void {
		if (this.disposed) {
			return;
		}
		if (this.active) {
			this.erase();
		}
		const layout = layoutDraft(prompt, text, cursorUtf16, this.output.columns ?? 80, this.output.rows ?? 24);
		this.output.write(layout.output);
		this.output.write("\r");
		if (layout.end.row > layout.cursor.row) {
			this.output.write(`\x1b[${layout.end.row - layout.cursor.row}A`);
		}
		if (layout.cursor.column > 0) {
			this.output.write(`\x1b[${layout.cursor.column}C`);
		}
		this.active = true;
		this.prompt = prompt;
		this.text = text;
		this.cursorUtf16 = cursorUtf16;
		this.cursorRow = layout.cursor.row;
		this.endRow = layout.end.row;
		this.endColumn = layout.end.column;
	}

	/** Remove the active draft from the screen while retaining it in memory. */
	clear(): void {
		if (this.active) {
			this.erase();
			this.active = false;
		}
	}

	/** Leave the submitted draft visible and start subsequent output below it. */
	finish(): void {
		if (!this.active) {
			return;
		}
		this.output.write("\r");
		if (this.endRow > this.cursorRow) {
			this.output.write(`\x1b[${this.endRow - this.cursorRow}B`);
		}
		if (this.endColumn > 0) {
			this.output.write("\r\n");
		}
		this.active = false;
	}

	/** Print a notice above an active draft, then restore the editable view. */
	print(message: string): void {
		const normalized = message.replace(/\r\n|\r|\n/g, "\n").replace(/\n/g, "\r\n");
		const line = normalized.endsWith("\r\n") ? normalized : `${normalized}\r\n`;
		if (this.active) {
			this.erase();
			this.active = false;
			this.output.write(line);
			this.show(this.prompt, this.text, this.cursorUtf16);
			return;
		}
		this.output.write(line);
	}

	dispose(): void {
		if (this.disposed) {
			return;
		}
		this.output.off("resize", this.onResize);
		this.disposed = true;
	}

	private erase(): void {
		this.output.write("\r");
		if (this.cursorRow > 0) {
			this.output.write(`\x1b[${this.cursorRow}A`);
		}
		this.output.write("\x1b[J");
	}
}
