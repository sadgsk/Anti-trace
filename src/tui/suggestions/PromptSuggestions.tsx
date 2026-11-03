import { useSyncExternalStore } from "react";
import { useStdout } from "ink";
import type { PromptSuggestionsController } from "./prompt-suggestions-controller.ts";
import { CommandMenu } from "./CommandMenu.tsx";

export interface PromptSuggestionsProps {
	controller: PromptSuggestionsController;
	availableColumns?: number;
	/** Total menu height, including borders and footer. */
	availableRows?: number;
}

/** The command menu stays in Ink's dynamic region, outside the transcript. */
export function PromptSuggestions({ controller, availableColumns, availableRows = 12 }: PromptSuggestionsProps) {
	const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
	const { stdout } = useStdout();
	return <CommandMenu state={state} availableColumns={availableColumns ?? stdout.columns ?? 80} availableRows={availableRows} />;
}
