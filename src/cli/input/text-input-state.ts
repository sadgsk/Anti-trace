import { getTextInputOffset, getTextInputPosition, layoutTextInput } from "./text-input-layout.ts";

/** Text is kept verbatim; cursor is a UTF-16 offset at a grapheme boundary. */
export interface TextInputState {
	readonly text: string;
	readonly cursor: number;
}

/** Editing operations are independent of terminal keys and shortcut bindings. */
export type TextInputAction =
	| { type: "insert"; text: string }
	| { type: "move"; direction: "left" | "right" }
	| { type: "move"; direction: "up"; availableColumns: number }
	| { type: "move"; direction: "down"; availableColumns: number }
	| { type: "delete"; direction: "backward" | "forward" };

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Include both ends, so the empty string still has the boundary [0]. */
function getGraphemeBoundaries(text: string): number[] {
	const boundaries = [0];
	for (const { index, segment } of graphemeSegmenter.segment(text)) {
		boundaries.push(index + segment.length);
	}
	return boundaries;
}

/** Default to the end; clamp an explicit cursor and snap left to a complete character. */
export function createTextInputState(text = "", cursor = text.length): TextInputState {
	const requested = Number.isFinite(cursor)
		? Math.max(0, Math.min(Math.trunc(cursor), text.length))
		: text.length;
	let offset = 0;
	for (const boundary of getGraphemeBoundaries(text)) {
		if (boundary > requested) break;
		offset = boundary;
	}
	return { text, cursor: offset };
}

/** Insert at the cursor, then place it after the inserted text without splitting a grapheme. */
export function insertText(state: TextInputState, value: string): TextInputState {
	if (value.length === 0) return state;
	const current = createTextInputState(state.text, state.cursor);
	const text = current.text.slice(0, current.cursor) + value + current.text.slice(current.cursor);
	const afterInsertedText = current.cursor + value.length;
	// Insertion can join neighbouring characters into a new cluster; segment the new text.
	const cursor = getGraphemeBoundaries(text).find(boundary => boundary >= afterInsertedText) ?? text.length;
	return { text, cursor };
}

/** The editing entry point supplies a valid cursor; move by one complete grapheme. */
function moveCursor(state: TextInputState, direction: "left" | "right"): TextInputState {
	const boundaries = getGraphemeBoundaries(state.text);
	const index = boundaries.indexOf(state.cursor);
	const cursor = boundaries[index + (direction === "left" ? -1 : 1)] ?? state.cursor;
	return cursor === state.cursor ? state : { text: state.text, cursor };
}

/** Move by display rows; the component can handle history when no adjacent row exists. */
function moveVerticalCursor(
	state: TextInputState,
	direction: "up" | "down",
	availableColumns: number,
): TextInputState {
	const layout = layoutTextInput(state.text, availableColumns);
	const position = getTextInputPosition(layout, state.cursor);
	const line = position.line + (direction === "up" ? -1 : 1);
	if (!layout.lines[line]) return state;
	const cursor = getTextInputOffset(layout, { line, column: position.column });
	return cursor === state.cursor ? state : { text: state.text, cursor };
}

/** Remove the adjacent grapheme, including a newline when moving across lines. */
function deleteText(state: TextInputState, direction: "backward" | "forward"): TextInputState {
	const adjacent = moveCursor(state, direction === "backward" ? "left" : "right");
	if (adjacent.cursor === state.cursor) return state;
	const start = Math.min(state.cursor, adjacent.cursor);
	const end = Math.max(state.cursor, adjacent.cursor);
	const text = state.text.slice(0, start) + state.text.slice(end);
	// Deletion can join neighbouring characters; snap left if their new cluster spans start.
	return createTextInputState(text, start);
}

/** Apply one editing operation and return the resulting text/cursor for the input component. */
export function applyTextInputAction(state: TextInputState, action: TextInputAction): TextInputState {
	const current = createTextInputState(state.text, state.cursor);
	switch (action.type) {
		case "insert":
			return insertText(current, action.text);
		case "move":
			return action.direction === "up" || action.direction === "down"
				? moveVerticalCursor(current, action.direction, action.availableColumns)
				: moveCursor(current, action.direction);
		case "delete":
			return deleteText(current, action.direction);
	}
}
