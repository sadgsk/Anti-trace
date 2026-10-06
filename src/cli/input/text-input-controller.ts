import type { InputTarget, RoutedInputEvent } from "./input-dispatcher.ts";
import { PasteHandler, type PasteHandlerOptions } from "./paste-handler.ts";
import type { PastedImage } from "../utils/image-paste.ts";
import { getTextInputOffset, getTextInputPosition, layoutTextInput } from "./text-input-layout.ts";
import { applyTextInputAction, createTextInputState, type TextInputAction, type TextInputState } from "./text-input-state.ts";

export interface TextInputOptions {
	/** Text columns only; reserve one additional column for the trailing cursor. */
	availableColumns: number;
	initialState?: TextInputState;
	multiline?: boolean;
	onChange?: (state: TextInputState, edit?: TextInputEdit) => void;
	/** Draft owners can keep a placeholder indivisible without teaching the editor about attachments. */
	transformEdit?: (edit: TextInputEdit, state: TextInputState) => TextInputEdit;
	transformCursor?: (cursor: number, state: TextInputState) => number;
	onUndo?: () => void;
	onRedo?: () => void;
	onSubmit?: (state: TextInputState) => void;
	/** Additional prompt submission rules, checked after the built-in paste pending gate. */
	canSubmit?: () => boolean;
	onPaste?: (event: Extract<RoutedInputEvent, { type: "paste" }>) => void;
	onImagePaste?: (image: PastedImage) => void;
	onPasteError?: (error: unknown) => void;
	/** Injectable readers let tests and future hosts avoid a real system clipboard. */
	pasteOptions?: Pick<PasteHandlerOptions, "readImage" | "readClipboard" | "platform">;
}

/** Exact replacement range, so repeated identical text cannot confuse attachment ownership. */
export interface TextInputEdit {
	readonly start: number;
	readonly end: number;
	readonly text: string;
}

export interface TextInputSnapshot {
	readonly state: TextInputState;
	readonly availableColumns: number;
	readonly isPasting: boolean;
}

const INPUT_ACTIONS = [
	"input:submit", "input:newline", "input:left", "input:right", "input:up", "input:down",
	"input:backspace", "input:delete", "input:home", "input:end",
	"input:paste-image",
	"input:undo", "input:redo",
] as const;

/** Synchronous editing state; React subscribes without becoming another stdin reader. */
export class TextInputController {
	private snapshot: TextInputSnapshot;
	private readonly listeners = new Set<() => void>();
	readonly pasteHandler: PasteHandler;
	private active = true;
	private replacingState = false;
	readonly target: InputTarget;

	constructor(private readonly options: TextInputOptions) {
		const state = options.initialState ?? createTextInputState();
		// Validate width at construction even for an empty input.
		layoutTextInput("", options.availableColumns);
		this.snapshot = {
			state: createTextInputState(state.text, state.cursor),
			availableColumns: options.availableColumns,
			isPasting: false,
		};
		this.pasteHandler = new PasteHandler({
			...options.pasteOptions,
			onInput: event => this.insertInput(event),
			onPaste: text => {
				if (options.onPaste) options.onPaste({ type: "paste", text, isPasted: true });
				else this.insertText(text);
			},
			onImagePaste: options.onImagePaste,
			onError: options.onPasteError,
			onPendingChange: isPasting => {
				this.snapshot = { ...this.snapshot, isPasting };
				if (!this.replacingState) this.notify();
			},
		});
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

	/** Replace the draft after submission or session changes. */
	replaceState(state: TextInputState): void {
		if (!this.active) return;
		const next = createTextInputState(state.text, state.cursor);
		const wasPending = this.snapshot.isPasting;
		const changed = next.text !== this.getState().text || next.cursor !== this.getState().cursor;
		this.replacingState = true;
		try { this.pasteHandler.cancel(); }
		finally { this.replacingState = false; }
		this.update(next, { start: 0, end: this.getState().text.length, text: next.text });
		if (!changed && wasPending) this.notify();
	}

	/** Restore an undo snapshot while preserving events queued after that undo action. */
	restoreState(state: TextInputState): void {
		if (!this.active) return;
		const next = createTextInputState(state.text, state.cursor);
		this.update(next, { start: 0, end: this.getState().text.length, text: next.text });
	}

	/** Paste consumers can insert a placeholder without cancelling the remaining ordered delivery. */
	insertText(text: string): void {
		if (this.active) this.edit({ type: "insert", text });
	}

	dispose(): void {
		if (!this.active) return;
		this.active = false;
		this.listeners.clear();
		this.pasteHandler.dispose();
	}

	setAvailableColumns(availableColumns: number): void {
		if (!this.active) return;
		layoutTextInput("", availableColumns);
		if (availableColumns === this.snapshot.availableColumns) return;
		this.snapshot = { ...this.snapshot, availableColumns };
		this.notify();
	}

	/** Actions arrive from the dispatcher; return false for actions owned by another layer. */
	handleAction(action: string, isEnter = false): boolean {
		if (!INPUT_ACTIONS.includes(action as typeof INPUT_ACTIONS[number])) return false;
		if (!this.active) return true;
		if (action === "input:submit") {
			if (this.pasteHandler.isPending() || this.options.canSubmit?.() === false) return true;
		} else if (action === "input:paste-image") {
			this.pasteHandler.pasteClipboard();
			return true;
		} else if (this.pasteHandler.isPending()) {
			this.pasteHandler.runAfterPaste(() => { if (this.active) this.applyAction(action, isEnter); });
			return true;
		}
		return this.applyAction(action, isEnter);
	}

	private applyAction(action: string, isEnter: boolean): boolean {
		const state = this.getState();
		switch (action) {
			case "input:undo": this.options.onUndo?.(); return true;
			case "input:redo": this.options.onRedo?.(); return true;
			case "input:submit":
				if (this.options.multiline !== false && state.text[state.cursor - 1] === "\\") {
					this.insertNewline(true);
				} else {
					// The caller accepts the snapshot and clears the draft when appropriate.
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
				this.edit({
					type: "move",
					direction: action === "input:up" ? "up" : "down",
					availableColumns: this.snapshot.availableColumns,
				});
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
		if (this.active) this.pasteHandler.handleInput(event);
	}

	private insertInput(event: RoutedInputEvent): void {
		if (event.type === "text" || event.type === "paste") {
			this.edit({ type: "insert", text: event.text });
		} else if (event.text && !event.ctrl && !event.alt && !event.meta
			&& !/[\u0000-\u001f\u007f-\u009f]/u.test(event.text)) {
			this.edit({ type: "insert", text: event.text });
		}
	}

	private edit(action: TextInputAction): void {
		const current = this.getState();
		if (action.type === "move") {
			this.update(applyTextInputAction(current, action));
		} else if (action.type === "insert") {
			this.applyEdit({ start: current.cursor, end: current.cursor, text: action.text });
		} else {
			const next = applyTextInputAction(current, action);
			const removed = current.text.length - next.text.length;
			const start = action.direction === "backward" ? current.cursor - removed : current.cursor;
			this.applyEdit({ start, end: start + removed, text: "" });
		}
	}

	private applyEdit(edit: TextInputEdit): void {
		const current = this.getState();
		const replacement = this.options.transformEdit?.(edit, current) ?? edit;
		const text = current.text.slice(0, replacement.start) + replacement.text + current.text.slice(replacement.end);
		const after = replacement.start + replacement.text.length;
		let next = createTextInputState(text, after);
		if (replacement.text.length > 0 && next.cursor < after) {
			next = applyTextInputAction(next, { type: "move", direction: "right" });
		}
		this.update(next, replacement);
	}

	private insertNewline(replaceBackslash: boolean): void {
		const state = this.getState();
		const start = replaceBackslash && state.text[state.cursor - 1] === "\\" ? state.cursor - 1 : state.cursor;
		this.applyEdit({ start, end: state.cursor, text: "\n" });
	}

	private update(state: TextInputState, edit?: TextInputEdit): void {
		const current = this.getState();
		if (!edit && this.options.transformCursor) {
			state = createTextInputState(state.text, this.options.transformCursor(state.cursor, current));
		}
		if (current.text === state.text && current.cursor === state.cursor) return;
		this.snapshot = { ...this.snapshot, state: { ...state } };
		try {
			this.options.onChange?.({ ...state }, edit);
		} finally {
			this.notify();
		}
	}

	private notify(): void {
		for (const listener of this.listeners) listener();
	}
}
