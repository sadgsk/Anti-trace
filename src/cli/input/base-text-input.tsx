import { Box, Text } from "ink";
import type { TextInputController } from "./text-input-controller.ts";
import { getTextInputPosition, layoutTextInput, splitTextInputLine } from "./text-input-layout.ts";
import { useTextInput } from "./use-text-input.ts";

export interface BaseTextInputProps {
	controller: TextInputController;
	/** The caller also removes this controller's target from focused dispatcher targets. */
	focus?: boolean;
	showCursor?: boolean;
}

/** Render the same measured rows used by editing; no Ink useInput or real stdin listener. */
export function BaseTextInput({ controller, focus = true, showCursor = true }: BaseTextInputProps) {
	const { state, availableColumns } = useTextInput(controller);
	const layout = layoutTextInput(state.text, availableColumns);
	const position = getTextInputPosition(layout, state.cursor);
	return (
		<Box flexDirection="column" width={availableColumns + 1} flexShrink={0}>
			{layout.lines.map((line, index) => {
				if (!focus || !showCursor || index !== position.line) {
					return <Text key={index} wrap="truncate-end">{line.text || " "}</Text>;
				}
				const { before, cursor, after } = splitTextInputLine(line, position.column);
				return (
					<Text key={index} wrap="truncate-end">
						{before}<Text inverse>{cursor}</Text>{after}
					</Text>
				);
			})}
		</Box>
	);
}
