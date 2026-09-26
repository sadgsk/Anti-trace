/**
 * A terminal-independent editable prompt. Input decoders decide whether bytes are
 * typing, paste, or a key; renderers only read this state. Neither can submit the
 * draft accidentally: submission happens only through submit().
 *
 * `cursor` is a UTF-16 offset into `text`. It is always on a grapheme boundary,
 * so callers can use it with String.slice without splitting an emoji or accent.
 */

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function normalizeNewlines(value: string): string {
	return value.replace(/\r\n?/g, "\n");
}

function boundaries(value: string): number[] {
	const result = [0];
	for (const part of graphemes.segment(value)) {
		result.push(part.index + part.segment.length);
	}
	return result;
}

function lowerBound(points: readonly number[], offset: number): number {
	let left = 0;
	let right = points.length;
	while (left < right) {
		const middle = (left + right) >>> 1;
		if (points[middle]! < offset) {
			left = middle + 1;
		} else {
			right = middle;
		}
	}
	return left;
}

function upperBound(points: readonly number[], offset: number): number {
	let left = 0;
	let right = points.length;
	while (left < right) {
		const middle = (left + right) >>> 1;
		if (points[middle]! <= offset) {
			left = middle + 1;
		} else {
			right = middle;
		}
	}
	return left;
}

function offsetForColumn(line: string, column: number): number {
	const points = boundaries(line);
	return points[Math.min(column, points.length - 1)]!;
}

export class DraftEditor {
	#text = "";
	#cursor = 0;
	#preferredColumn: number | undefined;
	#history: string[] = [];
	#historyIndex: number | undefined;
	#historyScratch = "";
	#boundaries: number[] | undefined;
	#newlines: number[] | undefined;

	constructor(initialText = "") {
		this.setText(initialText);
	}

	get text(): string {
		return this.#text;
	}

	/** UTF-16 offset into text, guaranteed to be a grapheme boundary. */
	get cursor(): number {
		return this.#cursor;
	}

	/** Zero-based logical line and grapheme column. Screen wrapping is renderer-owned. */
	get position(): { row: number; column: number } {
		const row = lowerBound(this.#newlineOffsets(), this.#cursor);
		const start = this.#lineStart();
		const points = this.#graphemeBoundaries();
		return { row, column: lowerBound(points, this.#cursor) - lowerBound(points, start) };
	}

	setText(value: string): void {
		this.#text = normalizeNewlines(value);
		this.#invalidateIndexes();
		this.#cursor = this.#text.length;
		this.#preferredColumn = undefined;
		this.#historyIndex = undefined;
		this.#historyScratch = "";
	}

	/** Clamp an arbitrary UTF-16 offset to the preceding grapheme boundary. */
	setCursor(offset: number): void {
		const clamped = Math.max(0, Math.min(this.#text.length, Math.trunc(offset) || 0));
		const points = this.#graphemeBoundaries();
		this.#cursor = points[upperBound(points, clamped) - 1]!;
		this.#preferredColumn = undefined;
	}

	/** Insert typed or pasted content exactly, except for CRLF/CR normalization. */
	insert(value: string): void {
		const content = normalizeNewlines(value);
		if (content.length === 0) {
			return;
		}
		this.#detachHistory();
		const insertedEnd = this.#cursor + content.length;
		this.#text = this.#text.slice(0, this.#cursor) + content + this.#text.slice(this.#cursor);
		this.#invalidateIndexes();
		const points = this.#graphemeBoundaries();
		this.#cursor = points[lowerBound(points, insertedEnd)]!;
		this.#preferredColumn = undefined;
	}

	newline(): void {
		this.insert("\n");
	}

	backspace(): boolean {
		if (this.#cursor === 0) {
			return false;
		}
		this.#detachHistory();
		const points = this.#graphemeBoundaries();
		const start = points[lowerBound(points, this.#cursor) - 1]!;
		this.#text = this.#text.slice(0, start) + this.#text.slice(this.#cursor);
		this.#invalidateIndexes();
		const newPoints = this.#graphemeBoundaries();
		this.#cursor = newPoints[upperBound(newPoints, start) - 1]!;
		this.#preferredColumn = undefined;
		return true;
	}

	deleteForward(): boolean {
		if (this.#cursor === this.#text.length) {
			return false;
		}
		this.#detachHistory();
		const points = this.#graphemeBoundaries();
		const end = points[upperBound(points, this.#cursor)]!;
		this.#text = this.#text.slice(0, this.#cursor) + this.#text.slice(end);
		this.#invalidateIndexes();
		const newPoints = this.#graphemeBoundaries();
		this.#cursor = newPoints[upperBound(newPoints, this.#cursor) - 1]!;
		this.#preferredColumn = undefined;
		return true;
	}

	moveLeft(): boolean {
		if (this.#cursor === 0) {
			return false;
		}
		const points = this.#graphemeBoundaries();
		this.#cursor = points[lowerBound(points, this.#cursor) - 1]!;
		this.#preferredColumn = undefined;
		return true;
	}

	moveRight(): boolean {
		if (this.#cursor === this.#text.length) {
			return false;
		}
		const points = this.#graphemeBoundaries();
		this.#cursor = points[upperBound(points, this.#cursor)]!;
		this.#preferredColumn = undefined;
		return true;
	}

	moveHome(): boolean {
		const start = this.#lineStart();
		this.#preferredColumn = undefined;
		const changed = this.#cursor !== start;
		this.#cursor = start;
		return changed;
	}

	moveEnd(): boolean {
		const end = this.#lineEnd();
		this.#preferredColumn = undefined;
		const changed = this.#cursor !== end;
		this.#cursor = end;
		return changed;
	}

	moveUp(): boolean {
		const start = this.#lineStart();
		if (start === 0) {
			return false;
		}
		const column = this.#preferredColumn ?? this.position.column;
		this.#preferredColumn = column;
		const previousEnd = start - 1;
		const newlines = this.#newlineOffsets();
		const previousNewline = newlines[lowerBound(newlines, previousEnd) - 1];
		const previousStart = previousNewline === undefined ? 0 : previousNewline + 1;
		const line = this.#text.slice(previousStart, previousEnd);
		this.#cursor = previousStart + offsetForColumn(line, column);
		return true;
	}

	moveDown(): boolean {
		const end = this.#lineEnd();
		if (end === this.#text.length) {
			return false;
		}
		const column = this.#preferredColumn ?? this.position.column;
		this.#preferredColumn = column;
		const nextStart = end + 1;
		const newlines = this.#newlineOffsets();
		const nextEnd = newlines[lowerBound(newlines, nextStart)] ?? this.#text.length;
		const line = this.#text.slice(nextStart, nextEnd);
		this.#cursor = nextStart + offsetForColumn(line, column);
		return true;
	}

	/** Return the untrimmed draft and clear it. Callers decide whether to send it. */
	submit(): string {
		const value = this.#text;
		if (value.length > 0 && this.#history.at(-1) !== value) {
			this.#history.push(value);
		}
		this.setText("");
		return value;
	}

	/** Recall previous submitted text, preserving the current unsent draft. */
	previousHistory(): boolean {
		if (this.#history.length === 0) {
			return false;
		}
		if (this.#historyIndex === undefined) {
			this.#historyScratch = this.#text;
			this.#historyIndex = this.#history.length - 1;
		} else if (this.#historyIndex > 0) {
			this.#historyIndex -= 1;
		} else {
			return false;
		}
		this.#loadHistoryText(this.#history[this.#historyIndex]!);
		return true;
	}

	/** Move toward the unsent draft after browsing history. */
	nextHistory(): boolean {
		if (this.#historyIndex === undefined) {
			return false;
		}
		if (this.#historyIndex === this.#history.length - 1) {
			this.#loadHistoryText(this.#historyScratch);
			this.#historyIndex = undefined;
			this.#historyScratch = "";
		} else {
			this.#historyIndex += 1;
			this.#loadHistoryText(this.#history[this.#historyIndex]!);
		}
		return true;
	}

	#lineStart(): number {
		const newlines = this.#newlineOffsets();
		const previous = newlines[lowerBound(newlines, this.#cursor) - 1];
		return previous === undefined ? 0 : previous + 1;
	}

	#lineEnd(): number {
		const newlines = this.#newlineOffsets();
		return newlines[lowerBound(newlines, this.#cursor)] ?? this.#text.length;
	}

	#loadHistoryText(value: string): void {
		this.#text = value;
		this.#invalidateIndexes();
		this.#cursor = value.length;
		this.#preferredColumn = undefined;
	}

	#detachHistory(): void {
		this.#historyIndex = undefined;
		this.#historyScratch = "";
	}

	#invalidateIndexes(): void {
		this.#boundaries = undefined;
		this.#newlines = undefined;
	}

	#graphemeBoundaries(): number[] {
		return (this.#boundaries ??= boundaries(this.#text));
	}

	#newlineOffsets(): number[] {
		if (this.#newlines === undefined) {
			this.#newlines = [];
			for (let index = this.#text.indexOf("\n"); index !== -1; index = this.#text.indexOf("\n", index + 1)) {
				this.#newlines.push(index);
			}
		}
		return this.#newlines;
	}
}
