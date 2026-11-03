import { Box, Text } from "ink";
import type { TextInputController } from "./text-input-controller.ts";
import { getTextInputPosition, layoutTextInput, splitTextInputLine } from "./text-input-layout.ts";
import { useTextInput } from "./use-text-input.ts";

export interface BaseTextInputProps {
	controller: TextInputController;
	/** The caller also removes this controller's target from focused dispatcher targets. */
	focus?: boolean;
	showCursor?: boolean;
	cursorColor?: string;
	maxRows?: number;
	placeholder?: string;
	mask?: boolean;
}

/** Render the same measured rows used by editing; no Ink useInput or real stdin listener. */
export function BaseTextInput({ controller, focus = true, showCursor = true, cursorColor, maxRows, placeholder, mask = false }: BaseTextInputProps) {
	const snapshot = useTextInput(controller);
	const { availableColumns } = snapshot;
	const state = mask ? { ...snapshot.state, text: snapshot.state.text.replace(/[^\r\n]/g, "•") } : snapshot.state;
	const layout = layoutTextInput(state.text, availableColumns);
	const position = getTextInputPosition(layout, state.cursor);
	const start = maxRows ? Math.max(0, Math.min(position.line - Math.floor(maxRows / 2), layout.lines.length - maxRows)) : 0;
	return (
		<Box flexDirection="column" width={availableColumns + 1} flexShrink={0}>
			{layout.lines.slice(start, maxRows ? start + maxRows : undefined).map((line, offset) => {
				const index = start + offset;
				if (!focus || !showCursor || index !== position.line) {
					return <Text key={index} wrap="truncate-end">{line.text || " "}</Text>;
				}
				const { before, cursor, after } = splitTextInputLine(line, position.column);
				return (
					<Text key={index} wrap="truncate-end">
						{before}<Text inverse={!cursorColor} backgroundColor={cursorColor} color={cursorColor ? "black" : undefined}>{cursor}</Text>{after}
						{!state.text && placeholder ? <Text dimColor>{placeholder}</Text> : null}
					</Text>
				);
			})}
		</Box>
	);
}
