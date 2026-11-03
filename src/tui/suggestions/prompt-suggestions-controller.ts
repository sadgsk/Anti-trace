import type { InputTarget } from "../../cli/input/input-dispatcher.ts";
import type { PromptInputController } from "../../cli/input/prompt-input-controller.ts";
import type { ReplController } from "../../cli/repl/repl-controller.ts";
import type { SlashCommandDefinition } from "../../cli/commands/command-registry.ts";
import { commandSuggestionQuery, getCommandSuggestions } from "./suggestion-sources.ts";
import { fileSuggestionQuery, WorkspaceFileIndex, type FileQuery } from "./file-index.ts";

export interface PromptSuggestionsSnapshot {
	readonly open: boolean;
	readonly items: readonly SlashCommandDefinition[];
	readonly selectedIndex: number;
	readonly kind?: "command" | "file";
	readonly loading?: boolean;
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
	private readonly files: WorkspaceFileIndex;
	private fileQuery: FileQuery | null = null;
	private generation = 0;

	constructor(private readonly prompt: PromptInputController, private readonly repl: ReplController, options: { cwd?: string } = {}) {
		this.files = new WorkspaceFileIndex(options.cwd ?? process.cwd());
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
		const enabled = !isPasting && !state.busy && !state.closed && !this.repl.dialogs.getSnapshot() && state.resumeChoices === null && draft.text !== this.dismissedText;
		const command = enabled ? commandSuggestionQuery(draft) : null;
		const file = enabled && command === null ? fileSuggestionQuery(draft) : null;
		const query = command !== null ? `command:${command}` : file ? `file:${file.start}:${file.query}` : null;
		if (query === this.query) return;
		this.query = query; this.fileQuery = file;
		const generation = ++this.generation;
		this.snapshot = { open: query !== null, items: command !== null ? getCommandSuggestions(command) : [], selectedIndex: 0,
			kind: file ? "file" : "command", loading: Boolean(file) };
		this.publish();
		if (file) void this.files.search(file.query).then(paths => {
			if (!this.active || this.generation !== generation) return;
			this.snapshot = { ...this.snapshot, loading: false, items: paths.map(name => ({ name, description: "工作区文件" })) };
			this.publish();
		});
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
			if (this.snapshot.loading) return;
			if (submit) this.prompt.handleAction("input:submit", true);
			return;
		}
		if (this.snapshot.kind === "file" && this.fileQuery) {
			const { start, end } = this.fileQuery;
			const value = /\s/.test(selected.name) ? `@"${selected.name}" ` : `@${selected.name} `;
			this.prompt.textInput.replaceRange(start, end, value);
			this.dismissedText = this.prompt.getDraft().text;
			this.refresh();
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
