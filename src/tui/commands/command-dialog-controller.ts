import type { InputTarget } from "../../cli/input/input-dispatcher.ts";
import { TextInputController } from "../../cli/input/text-input-controller.ts";
import { createTextInputState } from "../../cli/input/text-input-state.ts";
export interface CommandChoice { id: string; label: string; description?: string; current?: boolean; literal?: boolean; descriptionLiteral?: boolean }
export interface ConfigField { key: string; label: string; value: string; secret?: boolean; placeholder?: string; options?: readonly string[] }
interface DialogBase { title: string; description?: string; error?: string }
export interface ConfigFormState extends DialogBase { kind: "form"; fields: readonly ConfigField[]; selected: number }
export type CommandDialogState =
	| (DialogBase & { kind: "picker"; choices: readonly CommandChoice[]; selected: number; horizontal: boolean })
	| ConfigFormState
	| (DialogBase & { kind: "input"; field: ConfigField; selected: number })
	| (DialogBase & { kind: "field"; field: ConfigField; selected: number; form: ConfigFormState });

/** All modal input uses the host's existing dispatcher. Field drafts commit only on Enter. */
export class CommandDialogController {
	private state: CommandDialogState | null = null;
	private readonly listeners = new Set<() => void>();
	private acceptChoice?: (id: string) => void;
	private saveForm?: (values: Record<string, string>) => void;
	private goBack?: () => void;
	private acceptInput?: (value: string) => void;
	readonly editor = new TextInputController({ availableColumns: 60, multiline: false });
	readonly target: InputTarget = { id: Symbol("command-dialog"), context: "CommandDialog", actions: {
		...Object.fromEntries(Object.keys(this.editor.target.actions ?? {}).map(action => [action, () => { if ((this.state?.kind === "field" || this.state?.kind === "input") && !this.state.field.options) this.editor.handleAction(action); }])),
		"dialog:previous": () => this.move(-1), "dialog:next": () => this.move(1),
		"dialog:left": () => this.adjust(-1), "dialog:right": () => this.adjust(1),
		"dialog:accept": () => this.accept(), "dialog:cancel": () => this.cancel(), "dialog:save": () => this.save(),
	}, onInput: event => { if ((this.state?.kind === "field" || this.state?.kind === "input") && !this.state.field.options) this.editor.handleInput(event); } };
	getSnapshot = () => this.state;
	subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
	openPicker(options: { title: string; description?: string; choices: readonly CommandChoice[]; selectedId?: string; horizontal?: boolean; onAccept: (id: string) => void; onBack?: () => void }): void {
		this.clearEditor(); this.acceptChoice = options.onAccept; this.goBack = options.onBack; this.saveForm = undefined;
		this.set({ kind: "picker", title: options.title, description: options.description, choices: options.choices,
			selected: Math.max(0, options.choices.findIndex(item => item.id === options.selectedId || (!options.selectedId && item.current))), horizontal: options.horizontal ?? false });
	}
	openForm(options: { title: string; description?: string; fields: readonly ConfigField[]; onSave: (values: Record<string, string>) => void; onBack: () => void }): void {
		this.clearEditor(); this.acceptChoice = undefined; this.saveForm = options.onSave; this.goBack = options.onBack;
		this.set({ kind: "form", title: options.title, description: options.description, fields: options.fields, selected: 0 });
	}
	setColumns(columns: number): void { this.editor.setAvailableColumns(Math.max(1, columns - 7)); }
	openInput(options: { title: string; description?: string; placeholder?: string; onAccept: (value: string) => void; onBack?: () => void }): void {
		this.clearEditor(); this.acceptInput = options.onAccept; this.acceptChoice = undefined; this.saveForm = undefined; this.goBack = options.onBack;
		this.set({ kind: "input", selected: 0, title: options.title, description: options.description, field: { key: "value", label: options.title, value: "", placeholder: options.placeholder } });
	}
	showError(error: unknown): void { if (this.state) this.set({ ...this.state, error: error instanceof Error ? error.message : String(error) }); }
	close(): void { this.state = null; this.acceptChoice = undefined; this.acceptInput = undefined; this.saveForm = undefined; this.goBack = undefined; this.clearEditor(); this.publish(); }
	cancel(): void {
		if (this.state?.kind === "field") { const form = this.state.form; this.clearEditor(); this.set(form); return; }
		const back = this.goBack; this.close(); back?.();
	}
	dispose(): void { this.close(); this.editor.dispose(); this.listeners.clear(); }
	private move(direction: number): void {
		if (!this.state || this.editor.pasteHandler.isPending()) return;
		const length = this.state.kind === "picker" ? this.state.choices.length : this.state.kind === "form" ? this.state.fields.length + 1 : this.state.field.options?.length ?? 0;
		if (length) this.set({ ...this.state, selected: (this.state.selected + direction + length) % length });
	}
	private adjust(direction: number): void {
		if (this.state?.kind === "picker") { if (this.state.horizontal) this.move(direction); return; }
		if (this.state?.kind !== "field" && this.state?.kind !== "input") return;
		if (this.state.field.options) this.move(direction); else this.editor.handleAction(direction < 0 ? "input:left" : "input:right");
	}
	private accept(): void {
		if (!this.state || this.editor.pasteHandler.isPending()) return;
		if (this.state.kind === "input") { try { this.acceptInput?.(this.editor.getState().text); } catch (error) { this.showError(error); } return; }
		if (this.state.kind === "field") {
			const { field, form, selected } = this.state, value = field.options ? field.options[selected]! : this.editor.getState().text;
			this.clearEditor(); this.set({ ...form, error: undefined, fields: form.fields.map(item => item === field ? { ...item, value } : item) }); return;
		}
		if (this.state.kind === "form") {
			const field = this.state.fields[this.state.selected];
			if (!field) { this.save(); return; }
			const form = this.state; this.editor.replaceState(createTextInputState(field.value));
			this.set({ kind: "field", title: field.label, description: field.placeholder, field, form, selected: Math.max(0, field.options?.indexOf(field.value) ?? 0) }); return;
		}
		const selected = this.state.choices[this.state.selected];
		if (selected) try { this.acceptChoice?.(selected.id); } catch (error) { this.showError(error); }
	}
	private save(): void {
		if (this.state?.kind !== "form" || this.editor.pasteHandler.isPending()) return;
		try { this.saveForm?.(Object.fromEntries(this.state.fields.map(field => [field.key, field.value]))); } catch (error) { this.showError(error); }
	}
	private clearEditor(): void { this.editor.replaceState(createTextInputState()); }
	private set(state: CommandDialogState): void { this.state = state; this.publish(); }
	private publish(): void { for (const listener of this.listeners) listener(); }
}
