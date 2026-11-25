import { Box, Text, type DOMElement } from "ink";
import { useContext, useLayoutEffect, useRef } from "react";
import { ThemedText } from "../../tui/theme/ThemeProvider.tsx";
import type { TextInputController } from "./text-input-controller.ts";
import { getTextInputPosition, layoutTextInput, splitTextInputLine } from "./text-input-layout.ts";
import { useTextInput } from "./use-text-input.ts";
import { editorCell, TerminalCaretContext } from "./terminal-caret.ts";

export interface BaseTextInputProps {
	controller: TextInputController;
	/** The caller also removes this controller's target from focused dispatcher targets. */
	focus?: boolean;
	showCursor?: boolean;
	solidBlankCursor?: boolean;
	maxRows?: number;
	placeholder?: string;
	mask?: boolean;
}

/** Render the same measured rows used by editing; no Ink useInput or real stdin listener. */
export function BaseTextInput({ controller, focus = true, showCursor = true, solidBlankCursor = false, maxRows, placeholder, mask = false }: BaseTextInputProps) {
	const snapshot = useTextInput(controller);
	const { availableColumns } = snapshot;
	const state = mask ? { ...snapshot.state, text: snapshot.state.text.replace(/[^\r\n]/g, "•") } : snapshot.state;
	const layout = layoutTextInput(state.text, availableColumns);
	const position = getTextInputPosition(layout, state.cursor);
	const start = maxRows ? Math.max(0, Math.min(position.line - Math.floor(maxRows / 2), layout.lines.length - maxRows)) : 0;
	const box = useRef<DOMElement>(null);
	const registerCaret = useContext(TerminalCaretContext);
	useLayoutEffect(() => {
		if (!registerCaret || !focus || !showCursor) return;
		registerCaret(() => editorCell(box.current, position.line - start, position.column));
		return () => registerCaret(undefined);
	}, [registerCaret, focus, showCursor, position.line, position.column, start]);
	return (
		<Box ref={box} flexDirection="column" width={availableColumns + 1} flexShrink={0}>
			{layout.lines.slice(start, maxRows ? start + maxRows : undefined).map((line, offset) => {
				const index = start + offset;
				if (!focus || !showCursor || index !== position.line) {
					return <ThemedText key={index} wrap="truncate-end">{line.text || " "}</ThemedText>;
				}
				const { before, cursor, after } = splitTextInputLine(line, position.column);
				const caret = solidBlankCursor && cursor === " " ? "█"
					: <Text underline>{cursor}</Text>;
				return (
					<ThemedText key={index} wrap="truncate-end">
						{before}{caret}{after}
						{!state.text && placeholder}
					</ThemedText>
				);
			})}
		</Box>
	);
}
