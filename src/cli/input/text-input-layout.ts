import stringWidth from "string-width";

interface TextInputBoundary {
	readonly offset: number;
	readonly column: number;
}

/** Source offsets exclude the line break; text is the display projection of that range. */
export interface TextInputLine {
	readonly start: number;
	readonly end: number;
	readonly text: string;
	readonly width: number;
	readonly boundaries: readonly TextInputBoundary[];
}

export interface TextInputLayout {
	readonly lines: readonly TextInputLine[];
}

export interface TextInputPosition {
	readonly line: number;
	readonly column: number;
}

export interface TextInputLineParts {
	readonly before: string;
	readonly cursor: string;
	readonly after: string;
}

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const TAB_SIZE = 4;
const terminalControl = /[\u0000-\u001f\u007f-\u009f]/u;
const loneSurrogate = /\p{Surrogate}/u;

/** Measure display rows without rewriting the original text or dropping whitespace. */
export function layoutTextInput(text: string, availableColumns: number): TextInputLayout {
	// The caller has already reserved space for the prompt, borders and cursor.
	if (!Number.isInteger(availableColumns) || availableColumns <= 0) {
		throw new RangeError("availableColumns must be a positive integer");
	}
	const lines: TextInputLine[] = [];
	let start = 0;
	let end = 0;
	let displayText = "";
	let width = 0;
	let boundaries: TextInputBoundary[] = [{ offset: 0, column: 0 }];
	const finishLine = () => {
		lines.push({ start, end, text: displayText, width, boundaries });
	};
	const startLine = (offset: number) => {
		start = end = offset;
		displayText = "";
		width = 0;
		boundaries = [{ offset, column: 0 }];
	};

	for (const { index, segment } of graphemeSegmenter.segment(text)) {
		// Intl.Segmenter treats CRLF as one grapheme; keep both source characters intact.
		if (segment === "\n" || segment === "\r\n" || segment === "\r") {
			finishLine();
			startLine(index + segment.length);
			continue;
		}
		// Controls must not reach stdout as terminal commands; the source stays verbatim.
		// Node writes lone UTF-16 surrogates as visible replacement characters, not zero-width text.
		let displaySegment = terminalControl.test(segment) || loneSurrogate.test(segment) ? "�" : segment;
		let segmentWidth = segment === "\t"
			? Math.min(TAB_SIZE - width % TAB_SIZE, availableColumns)
			: stringWidth(displaySegment);
		// Ink allocates at least one cell to each standalone cluster. Keep measurement in sync,
		// including zero-width clusters and graphemes too wide for this row.
		if (segmentWidth === 0 || segmentWidth > availableColumns) {
			displaySegment = "�";
			segmentWidth = 1;
		}
		if (width > 0 && width + segmentWidth > availableColumns) {
			finishLine();
			startLine(index);
			if (segment === "\t") segmentWidth = Math.min(TAB_SIZE, availableColumns);
		}
		displayText += segment === "\t" ? " ".repeat(segmentWidth) : displaySegment;
		width += segmentWidth;
		end = index + segment.length;
		boundaries.push({ offset: end, column: width });
	}
	// Always retain the empty row, including one after a trailing line break.
	finishLine();
	return { lines };
}

/** A soft-wrap boundary belongs to the following row, matching cursor rendering. */
export function getTextInputPosition(layout: TextInputLayout, cursor: number): TextInputPosition {
	let lineIndex = layout.lines.length - 1;
	while (lineIndex > 0 && layout.lines[lineIndex]!.start > cursor) lineIndex--;
	const line = layout.lines[lineIndex]!;
	let column = 0;
	for (const boundary of line.boundaries) {
		if (boundary.offset > cursor) break;
		column = boundary.column;
	}
	return { line: lineIndex, column };
}

/** Snap left inside wide graphemes and clamp to the last boundary owned by this row. */
export function getTextInputOffset(layout: TextInputLayout, position: TextInputPosition): number {
	const line = layout.lines[position.line];
	if (!line) throw new RangeError("position must refer to an existing input row");
	const nextStart = layout.lines[position.line + 1]?.start;
	let cursor = line.start;
	for (const boundary of line.boundaries) {
		// The shared end of a soft-wrapped row would put the cursor on the next row.
		if (boundary.column > position.column || boundary.offset === nextStart) break;
		cursor = boundary.offset;
	}
	return cursor;
}

/** Split display text at a screen column, keeping wide graphemes intact for cursor styling. */
export function splitTextInputLine(line: TextInputLine, column: number): TextInputLineParts {
	let width = 0;
	for (const { index, segment } of graphemeSegmenter.segment(line.text)) {
		const segmentWidth = stringWidth(segment);
		// Zero-width text stays before the cursor, including at a shared display column.
		if (segmentWidth > 0 && width + segmentWidth > column) {
			return {
				before: line.text.slice(0, index),
				cursor: segment,
				after: line.text.slice(index + segment.length),
			};
		}
		width += segmentWidth;
	}
	return { before: line.text, cursor: " ", after: "" };
}
