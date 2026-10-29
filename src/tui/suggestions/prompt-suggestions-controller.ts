import type { InputTarget } from "../../cli/input/input-dispatcher.ts";
import type { PromptInputController } from "../../cli/input/prompt-input-controller.ts";
import type { ReplController } from "../../cli/repl/repl-controller.ts";
import type { SlashCommandDefinition } from "../../cli/commands/command-registry.ts";
import { commandSuggestionQuery, getCommandSuggestions } from "./suggestion-sources.ts";

export interface PromptSuggestionsSnapshot {
	readonly open: boolean;
	readonly items: readonly SlashCommandDefinition[];
	readonly selectedIndex: number;
}

/** Draft/repl state in; focused menu actions and a renderable selection out. No stdin access. */
export class PromptSuggestionsController {
	readonly target: InputTarget;
	private snapshot: PromptSuggestionsSnapshot = { open: false, items: [], selectedIndex: 0 };
	private readonly listeners = new Set<() => void>();
	private readonly unsubscribes: readonly (() => void)[];
	private query: string | null = null;
	private dismissedText: string | undefined;
	private active = true;

	constructor(private readonly prompt: PromptInputController, private readonly repl: ReplController) {
		this.target = {
			id: Symbol("prompt-suggestions"), context: "Suggestions",
			actions: {
				"suggestions:previous": () => this.move(-1),
				"suggestions:next": () => this.move(1),
				"suggestions:accept": () => this.accept(true),
				"suggestions:complete": () => this.accept(false),
				"suggestions:dismiss": () => this.dismiss(),
			},
			// Printable input and paste still belong to the prompt while the menu has focus.
			onInput: event => prompt.handleInput(event),
		};
		this.unsubscribes = [prompt.subscribe(() => this.refresh()), repl.subscribe(() => this.refresh())];
		this.refresh();
	}

	getSnapshot = (): PromptSuggestionsSnapshot => this.snapshot;
	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => { this.listeners.delete(listener); };
	};

	dispose(): void {
		this.active = false;
		for (const unsubscribe of this.unsubscribes) unsubscribe();
		this.listeners.clear();
	}

	private refresh(): void {
		if (!this.active) return;
		const { draft, isPasting } = this.prompt.getSnapshot();
		if (draft.text !== this.dismissedText) this.dismissedText = undefined;
		const state = this.repl.getSnapshot();
		const query = !isPasting && !state.busy && !state.closed && state.resumeChoices === null
			&& draft.text !== this.dismissedText ? commandSuggestionQuery(draft) : null;
		if (query === this.query) return;
		this.query = query;
		this.snapshot = { open: query !== null, items: query === null ? [] : getCommandSuggestions(query), selectedIndex: 0 };
		this.publish();
	}

	private move(direction: number): void {
		const { items, selectedIndex } = this.snapshot;
		if (items.length === 0) return;
		this.snapshot = { ...this.snapshot, selectedIndex: (selectedIndex + direction + items.length) % items.length };
		this.publish();
	}

	private dismiss(): void {
		this.dismissedText = this.prompt.getDraft().text;
		this.refresh();
	}

	private accept(submit: boolean): void {
		if (!this.snapshot.open || this.prompt.textInput.pasteHandler.isPending() || !this.repl.canSubmit()) return;
		const selected = this.snapshot.items[this.snapshot.selectedIndex];
		if (!selected) {
			if (submit) this.prompt.handleAction("input:submit", true);
			return;
		}
		const text = `/${selected.name}${selected.argumentHint && (!submit || selected.argumentRequired) ? " " : ""}`;
		this.dismissedText = text;
		// One edit keeps completion undoable, including when it replaces a typed prefix.
		this.prompt.textInput.replaceText(text);
		this.refresh();
		if (submit && !selected.argumentRequired) void this.repl.submit(this.prompt.getDraft());
	}

	private publish(): void {
		for (const listener of this.listeners) listener();
	}
}
