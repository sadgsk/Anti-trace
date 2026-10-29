import { SLASH_COMMANDS, type SlashCommandDefinition } from "../../cli/commands/command-registry.ts";
import type { PromptDraft } from "../../cli/input/prompt-draft.ts";

/** Only a command token at the start of a plain, single-line draft opens the menu. */
export function commandSuggestionQuery(draft: PromptDraft): string | null {
	if (draft.references.length > 0 || draft.cursor !== draft.text.length || !/^\/[a-z-]*$/u.test(draft.text)) return null;
	return draft.text.slice(1);
}

export function getCommandSuggestions(query: string): readonly SlashCommandDefinition[] {
	const matches = SLASH_COMMANDS.filter(command => command.name.startsWith(query));
	// An exact command must win over a longer command with the same prefix.
	return [...matches.filter(command => command.name === query), ...matches.filter(command => command.name !== query)];
}
