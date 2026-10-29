import { useSyncExternalStore } from "react";
import { Box, Text } from "ink";
import { commandUsage } from "../../cli/commands/command-registry.ts";
import type { PromptSuggestionsController } from "./prompt-suggestions-controller.ts";

export interface PromptSuggestionsProps {
	controller: PromptSuggestionsController;
	availableRows?: number;
}

/** The command menu stays in Ink's dynamic region, outside the transcript. */
export function PromptSuggestions({ controller, availableRows = 6 }: PromptSuggestionsProps) {
	const { open, items, selectedIndex } = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
	if (!open) return null;
	const count = Math.max(1, Math.min(6, availableRows));
	const start = Math.max(0, Math.min(selectedIndex - Math.floor(count / 2), items.length - count));
	return <Box flexDirection="column">
		{items.length === 0 ? <Text dimColor>无匹配命令，Esc 收起</Text> : <>
			{items.slice(start, start + count).map((command, index) => <Text key={command.name} inverse={start + index === selectedIndex} wrap="truncate">
				{start + index === selectedIndex ? "> " : "  "}{commandUsage(command)} · {command.description}
			</Text>)}
			<Text dimColor wrap="truncate">↑↓ 选择 · Enter 确认 · Tab 补全 · Esc 收起 · {selectedIndex + 1}/{items.length}</Text>
		</>}
	</Box>;
}
