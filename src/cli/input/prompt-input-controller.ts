import type { InputTarget, RoutedInputEvent } from "./input-dispatcher.ts";
import { PASTE_THRESHOLD, type PasteHandlerOptions } from "./paste-handler.ts";
import {
	createPromptDraft, imagePastedContent, snapshotPromptDraft,
	type PastedContent, type PromptDraft,
} from "./prompt-draft.ts";
import { TextInputController, type TextInputEdit } from "./text-input-controller.ts";
import { layoutTextInput } from "./text-input-layout.ts";
import { applyTextInputAction, createTextInputState, type TextInputState } from "./text-input-state.ts";
import type { PastedImage } from "../utils/image-paste.ts";

export interface PromptInputOptions {
	availableColumns: number;
	initialDraft?: PromptDraft;
	/** CC folds pastes taller than two rows, in addition to the 800-character limit. */
	maxPasteLines?: number;
	maxUndoEntries?: number;
	onSubmit?: (draft: PromptDraft) => void;
	onChange?: (draft: PromptDraft) => void;
	canSubmit?: () => boolean;
	onPasteError?: (error: unknown) => void;
	pasteOptions?: Pick<PasteHandlerOptions, "readImage" | "readClipboard" | "platform">;
}

export interface PromptInputSnapshot {
	readonly draft: PromptDraft;
	readonly availableColumns: number;
	readonly isPasting: boolean;
	readonly canUndo: boolean;
	readonly canRedo: boolean;
}

/** Own one complete editable prompt; the terminal host remains the sole stdin reader. */
export class PromptInputController {
	readonly textInput: TextInputController;
	readonly target: InputTarget;
	private draft: PromptDraft;
	private snapshot: PromptInputSnapshot;
	private readonly listeners = new Set<() => void>();
	private readonly undoEntries: PromptDraft[] = [];
	private readonly redoEntries: PromptDraft[] = [];
	private nextPasteId = 1;
	private restoring = false;
	private active = true;
	private inserting: { content: PastedContent; label: string } | undefined;
	private readonly unsubscribe: () => void;
	private readonly maxPasteLines: number;
	private readonly maxUndoEntries: number;

	constructor(private readonly options: PromptInputOptions) {
		this.maxPasteLines = options.maxPasteLines ?? 2;
		this.maxUndoEntries = options.maxUndoEntries ?? 100;
		if (!Number.isInteger(this.maxPasteLines) || this.maxPasteLines < 1
			|| !Number.isInteger(this.maxUndoEntries) || this.maxUndoEntries < 1) {
			throw new RangeError("Paste lines and undo capacity must be positive integers");
		}
		this.draft = snapshotPromptDraft(options.initialDraft ?? createPromptDraft());
		this.nextPasteId = Math.max(0, ...this.draft.references.map(ref => ref.id)) + 1;
		this.textInput = new TextInputController({
			availableColumns: options.availableColumns, initialState: this.draft,
			pasteOptions: options.pasteOptions, onPasteError: options.onPasteError,
			canSubmit: options.canSubmit,
			onChange: (state, edit) => this.acceptEdit(state, edit),
			transformEdit: edit => this.transformEdit(edit),
			transformCursor: (cursor, state) => this.transformCursor(cursor, state),
			onPaste: event => this.pasteText(event.text),
			onImagePaste: image => this.pasteImage(image),
			onUndo: () => this.restoreHistory(this.undoEntries, this.redoEntries),
			onRedo: () => this.restoreHistory(this.redoEntries, this.undoEntries),
			onSubmit: () => options.onSubmit?.(this.getDraft()),
		});
		this.target = this.textInput.target;
		this.snapshot = this.makeSnapshot();
		this.unsubscribe = this.textInput.subscribe(() => this.publish());
	}

	getDraft = (): PromptDraft => this.draft;
	getSnapshot = (): PromptInputSnapshot => this.snapshot;
	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => { this.listeners.delete(listener); };
	};
	handleAction(action: string, isEnter = false): boolean { return this.textInput.handleAction(action, isEnter); }
	handleInput(event: RoutedInputEvent): void { this.textInput.handleInput(event); }
	setAvailableColumns(columns: number): void { this.textInput.setAvailableColumns(columns); }

	/** An accepted submit/session switch clears attachments, undo and old asynchronous paste results. */
	reset(draft: PromptDraft = createPromptDraft()): void {
		if (!this.active) return;
		const next = snapshotPromptDraft(draft);
		this.restoring = true;
		try {
			this.draft = next;
			this.undoEntries.length = 0;
			this.redoEntries.length = 0;
			this.nextPasteId = Math.max(0, ...next.references.map(ref => ref.id)) + 1;
			this.textInput.replaceState(next);
		} finally { this.restoring = false; }
		this.publish();
		this.options.onChange?.(this.draft);
	}

	dispose(): void {
		if (!this.active) return;
		this.active = false;
		this.unsubscribe();
		this.listeners.clear();
		this.textInput.dispose();
		this.undoEntries.length = 0;
		this.redoEntries.length = 0;
		this.snapshot = this.makeSnapshot();
	}

	private pasteText(text: string): void {
		const lines = layoutTextInput(text, this.textInput.getSnapshot().availableColumns).lines.length;
		if (text.length <= PASTE_THRESHOLD && lines <= this.maxPasteLines) {
			this.textInput.insertText(text);
			return;
		}
		const id = this.nextPasteId++;
		const label = `[Pasted text #${id}${lines > 1 ? ` +${lines - 1} lines` : ""}]`;
		this.insertReference({ id, type: "text", text }, label);
	}

	private pasteImage(image: PastedImage): void {
		const id = this.nextPasteId++;
		this.insertReference(imagePastedContent(id, image), `[Image #${id}]`);
	}

	private insertReference(content: PastedContent, label: string): void {
		this.inserting = { content, label };
		try { this.textInput.insertText(label); }
		finally { this.inserting = undefined; }
	}

	/** Move insertion out of chips; a deletion touching a chip removes its whole reference. */
	private transformEdit(edit: TextInputEdit): TextInputEdit {
		if (this.restoring) return edit;
		if (edit.start === edit.end) {
			const ref = this.draft.references.find(ref => edit.start > ref.start && edit.start < ref.end);
			return ref ? { ...edit, start: ref.end, end: ref.end } : edit;
		}
		let start = edit.start;
		let end = edit.end;
		for (const ref of this.draft.references) {
			if (start < ref.end && end > ref.start) {
				start = Math.min(start, ref.start);
				end = Math.max(end, ref.end);
			}
		}
		return { ...edit, start, end };
	}

	private transformCursor(cursor: number, state: TextInputState): number {
		const ref = this.draft.references.find(ref => cursor > ref.start && cursor < ref.end);
		if (!ref) return cursor;
		if (cursor < state.cursor) return ref.start;
		const end = createTextInputState(state.text, ref.end);
		// A user combining mark after ']' can share its grapheme; step past that whole cluster.
		return end.cursor === ref.end ? ref.end : applyTextInputAction(end, { type: "move", direction: "right" }).cursor;
	}

	/** Text edits update positions and attachment ownership in the same synchronous draft change. */
	private acceptEdit(state: TextInputState, edit?: TextInputEdit): void {
		if (this.restoring) return;
		const before = this.draft;
		let references = [...before.references];
		const pastedContents = { ...before.pastedContents };
		if (edit) {
			const delta = edit.text.length - (edit.end - edit.start);
			references = references.flatMap(ref => {
				if (ref.end <= edit.start) return [ref];
				if (ref.start >= edit.end) return [{ ...ref, start: ref.start + delta, end: ref.end + delta }];
				delete pastedContents[ref.id];
				return [];
			});
			if (this.inserting) {
				const { content, label } = this.inserting;
				this.inserting = undefined;
				pastedContents[content.id] = content;
				references.push({ id: content.id, label, start: edit.start, end: edit.start + label.length });
			}
		}
		this.draft = snapshotPromptDraft({ ...state, references, pastedContents });
		if (state.text !== before.text) {
			this.pushHistory(this.undoEntries, before);
			this.redoEntries.length = 0;
		}
		this.snapshot = this.makeSnapshot();
		this.options.onChange?.(this.draft);
	}

	private restoreHistory(from: PromptDraft[], to: PromptDraft[]): void {
		const draft = from.pop();
		if (!draft || !this.active) return;
		this.pushHistory(to, this.draft);
		this.restoring = true;
		try {
			this.draft = draft;
			this.textInput.restoreState(draft);
		} finally { this.restoring = false; }
		this.publish();
		this.options.onChange?.(this.draft);
	}

	private pushHistory(entries: PromptDraft[], draft: PromptDraft): void {
		entries.push(draft);
		if (entries.length > this.maxUndoEntries) entries.shift();
	}

	private makeSnapshot(): PromptInputSnapshot {
		const text = this.textInput.getSnapshot();
		return Object.freeze({ draft: this.draft, availableColumns: text.availableColumns,
			isPasting: text.isPasting, canUndo: this.undoEntries.length > 0, canRedo: this.redoEntries.length > 0 });
	}

	private publish(): void {
		if (!this.active || this.restoring) return;
		this.snapshot = this.makeSnapshot();
		for (const listener of this.listeners) listener();
	}
}
