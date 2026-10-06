import { Box, Text } from "ink";
import { useSyncExternalStore } from "react";
import { BaseTextInput } from "./base-text-input.tsx";
import type { PromptInputController } from "./prompt-input-controller.ts";

export interface PromptInputProps {
	controller: PromptInputController;
	focus?: boolean;
	showCursor?: boolean;
}

/** Prompt display consumes the draft store; it never subscribes to real stdin. */
export function PromptInput({ controller, focus = true, showCursor = true }: PromptInputProps) {
	const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
	return <Box flexDirection="column">
		<BaseTextInput controller={controller.textInput} focus={focus} showCursor={showCursor} />
		{snapshot.isPasting && <Text dimColor>Processing paste…</Text>}
	</Box>;
}
