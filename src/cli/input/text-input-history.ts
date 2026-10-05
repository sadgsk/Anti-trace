import { createTextInputState, type TextInputState } from "./text-input-state.ts";

/** In-memory text history; entries are supplied from oldest to newest by the caller. */
export class TextInputHistory {
	private entries: readonly TextInputState[] = [];
	private index = 0;
	private draft: TextInputState | null = null;

	constructor(entries: readonly TextInputState[] = []) {
		this.replace(entries);
	}

	/** Replace the history snapshot and leave any active browsing session. */
	replace(entries: readonly TextInputState[]): void {
		this.entries = entries.map(entry => createTextInputState(entry.text, entry.cursor));
		this.reset();
	}

	/** Keep entries, but forget the browsing position and saved draft. */
	reset(): void {
		this.index = this.entries.length;
		this.draft = null;
	}

	/**
	 * The editor calls this only when vertical cursor movement reaches its boundary.
	 * Like CC, Up recalls at the start and Down at the end. Returning to the draft
	 * restores both its original text and cursor, including an empty/whitespace draft.
	 * Edits to a recalled entry are discarded when browsing continues; this helper
	 * does not add submitted input to history or persist entries.
	 */
	move(current: TextInputState, direction: "up" | "down"): TextInputState | null {
		if (direction === "up") {
			const entry = this.entries[this.index - 1];
			if (!entry) return null;
			if (this.index === this.entries.length) {
				this.draft = createTextInputState(current.text, current.cursor);
			}
			this.index--;
			return createTextInputState(entry.text, 0);
		}

		if (this.index >= this.entries.length) return null;
		this.index++;
		if (this.index === this.entries.length) {
			const draft = this.draft;
			this.reset();
			return draft;
		}
		const entry = this.entries[this.index]!;
		return createTextInputState(entry.text, entry.text.length);
	}
}
