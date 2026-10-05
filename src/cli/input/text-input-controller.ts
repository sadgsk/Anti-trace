import type { InputTarget, RoutedInputEvent } from "./input-dispatcher.ts";
import { TextInputHistory } from "./text-input-history.ts";
import { getTextInputOffset, getTextInputPosition, layoutTextInput } from "./text-input-layout.ts";
import { applyTextInputAction, createTextInputState, type TextInputAction, type TextInputState } from "./text-input-state.ts";

export interface TextInputOptions {
	/** Text columns only; reserve one additional column for the trailing cursor. */
	availableColumns: number;
	initialState?: TextInputState;
	/** Oldest first. Persistence and recording accepted submissions belong to the caller. */
	history?: readonly TextInputState[];
	multiline?: boolean;
	onChange?: (state: TextInputState) => void;
	onSubmit?: (state: TextInputState) => void;
	/** A synchronous gate for the later paste buffer and prompt submission rules. */
	canSubmit?: () => boolean;
	onPaste?: (event: Extract<RoutedInputEvent, { type: "paste" }>) => void;
	/** Rich prompt history can replace the base text-only navigator. */
	onHistory?: (direction: "up" | "down") => void;
}

export interface TextInputSnapshot {
	readonly state: TextInputState;
	readonly availableColumns: number;
}

const INPUT_ACTIONS = [
	"input:submit", "input:newline", "input:left", "input:right", "input:up", "input:down",
	"input:backspace", "input:delete", "input:home", "input:end",
] as const;

/** Synchronous editing state; React subscribes without becoming another stdin reader. */
export class TextInputController {
	private snapshot: TextInputSnapshot;
	private readonly listeners = new Set<() => void>();
	private readonly history: TextInputHistory;
	readonly target: InputTarget;

	constructor(private readonly options: TextInputOptions) {
		const state = options.initialState ?? createTextInputState();
		// Validate width at construction even for an empty input.
		layoutTextInput("", options.availableColumns);
		this.snapshot = {
			state: createTextInputState(state.text, state.cursor),
			availableColumns: options.availableColumns,
		};
		this.history = new TextInputHistory(options.history);
		this.target = {
			id: Symbol("text-input"),
			context: "Input",
			actions: Object.fromEntries(INPUT_ACTIONS.map(action => [action, (event: RoutedInputEvent) => {
				this.handleAction(action, event.type === "key" && event.name === "enter");
			}])),
			onInput: event => this.handleInput(event),
		};
	}

	getSnapshot = (): TextInputSnapshot => this.snapshot;
	getState = (): TextInputState => this.snapshot.state;

	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => { this.listeners.delete(listener); };
	};

	/** Replace the draft after submission, session changes or richer history restoration. */
	replaceState(state: TextInputState): void {
		this.history.reset();
		this.update(createTextInputState(state.text, state.cursor));
	}

	replaceHistory(entries: readonly TextInputState[]): void {
		this.history.replace(entries);
	}

	setAvailableColumns(availableColumns: number): void {
		layoutTextInput("", availableColumns);
		if (availableColumns === this.snapshot.availableColumns) return;
		this.snapshot = { ...this.snapshot, availableColumns };
		this.notify();
	}

	/** Actions arrive from the dispatcher; return false for actions owned by another layer. */
	handleAction(action: string, isEnter = false): boolean {
		const state = this.getState();
		switch (action) {
			case "input:submit":
				if (this.options.canSubmit?.() === false) return true;
				if (this.options.multiline !== false && state.text[state.cursor - 1] === "\\") {
					this.insertNewline(true);
				} else {
					// No automatic clearing/history write: the caller owns acceptance of the snapshot.
					this.options.onSubmit?.({ ...state });
				}
				return true;
			case "input:newline":
				if (this.options.multiline !== false) this.insertNewline(isEnter);
				return true;
			case "input:left": case "input:right":
				this.edit({ type: "move", direction: action === "input:left" ? "left" : "right" });
				return true;
			case "input:up": case "input:down":
				this.moveVertical(action === "input:up" ? "up" : "down");
				return true;
			case "input:backspace": case "input:delete":
				this.edit({ type: "delete", direction: action === "input:backspace" ? "backward" : "forward" });
				return true;
			case "input:home": case "input:end": {
				const layout = layoutTextInput(state.text, this.snapshot.availableColumns);
				const position = getTextInputPosition(layout, state.cursor);
				// CC's Home at column zero goes to the previous visual row's start.
				const line = action === "input:home" && position.column === 0
					? Math.max(0, position.line - 1) : position.line;
				const column = action === "input:home" ? 0 : layout.lines[line]!.width;
				this.update(createTextInputState(state.text, getTextInputOffset(layout, { line, column })));
				return true;
			}
			default:
				return false;
		}
	}

	/** Unbound keys never insert their raw escape sequences or modifier shortcuts. */
	handleInput(event: RoutedInputEvent): void {
		if (event.type === "paste") {
			if (this.options.onPaste) this.options.onPaste(event);
			else this.edit({ type: "insert", text: event.text });
		} else if (event.type === "text") {
			this.edit({ type: "insert", text: event.text });
		} else if (event.text && !event.ctrl && !event.alt && !event.meta
			&& !/[\u0000-\u001f\u007f-\u009f]/u.test(event.text)) {
			this.edit({ type: "insert", text: event.text });
		}
	}

	private edit(action: TextInputAction): void {
		this.update(applyTextInputAction(this.getState(), action));
	}

	private insertNewline(replaceBackslash: boolean): void {
		let state = this.getState();
		if (replaceBackslash && state.text[state.cursor - 1] === "\\") {
			state = applyTextInputAction(state, { type: "delete", direction: "backward" });
		}
		this.update(applyTextInputAction(state, { type: "insert", text: "\n" }));
	}

	private moveVertical(direction: "up" | "down"): void {
		const state = this.getState();
		const layout = layoutTextInput(state.text, this.snapshot.availableColumns);
		const position = getTextInputPosition(layout, state.cursor);
		const adjacent = position.line + (direction === "up" ? -1 : 1);
		if (layout.lines[adjacent]) {
			this.edit({ type: "move", direction, availableColumns: this.snapshot.availableColumns });
		} else if (this.options.onHistory) {
			this.options.onHistory(direction);
		} else {
			const recalled = this.history.move(state, direction);
			if (recalled) this.update(recalled);
		}
	}

	private update(state: TextInputState): void {
		const current = this.getState();
		if (current.text === state.text && current.cursor === state.cursor) return;
		this.snapshot = { ...this.snapshot, state: { ...state } };
		try {
			this.options.onChange?.({ ...state });
		} finally {
			this.notify();
		}
	}

	private notify(): void {
		for (const listener of this.listeners) listener();
	}
}
