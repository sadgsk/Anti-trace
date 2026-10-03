import type { TerminalInputEvent } from "../ink/terminal-input.ts";
import {
	DEFAULT_KEYBINDINGS,
	resolveKeybinding,
	type Keybinding,
	type Keystroke,
	type PendingChord,
} from "./keybindings.ts";

export type RoutedInputEvent = Extract<TerminalInputEvent, { type: "key" | "text" | "paste" }>;
type KeystrokeEvent = Exclude<RoutedInputEvent, { type: "paste" }>;

/** A synchronous false lets the focused component handle the original event. */
export type InputActionHandler = (event: KeystrokeEvent) => void | false;

export interface InputTarget {
	/** Stable component identity, separate from its shared shortcut context name. */
	id: symbol;
	context: string;
	actions?: Readonly<Partial<Record<string, InputActionHandler>>>;
	onInput?: (event: RoutedInputEvent) => void;
}

const CHORD_TIMEOUT_MS = 1000;

/** CC's getKeyName also leaves multi-character input blocks out of shortcut matching. */
function eventToKeystroke(event: RoutedInputEvent): Keystroke | null {
	if (event.type === "key") return event;
	if (event.type !== "text" || [...event.text].length !== 1) return null;
	return {
		name: event.text === " " ? "space" : event.text.toLowerCase(),
		ctrl: false,
		alt: false,
		shift: /^[A-Z]$/.test(event.text),
		meta: false,
	};
}

/** Receives the host's events; never reads stdin or performs editor/REPL actions itself. */
export class InputDispatcher {
	private targets: readonly InputTarget[] = [];
	private bindings: readonly Keybinding[] = DEFAULT_KEYBINDINGS;
	private pending: PendingChord | null = null;
	private pendingUntil = 0;

	/**
	 * Targets are ordered from focused component through outer scopes to Global.
	 * Reuse each mounted component's id; update handlers freely without cancelling a chord.
	 * Replace the bindings array when its configuration changes, instead of mutating it.
	 */
	configure(targets: readonly InputTarget[], bindings: readonly Keybinding[] = DEFAULT_KEYBINDINGS): void {
		const sameFocus = targets.length === this.targets.length
			&& targets.every((target, index) => target.id === this.targets[index]!.id
				&& target.context === this.targets[index]!.context);
		if (!sameFocus || bindings !== this.bindings) {
			this.pending = null;
			this.pendingUntil = 0;
		}
		// Snapshot identity and context so later caller edits cannot hide a focus change.
		this.targets = targets.map(target => ({ ...target }));
		this.bindings = bindings;
	}

	/** Returns true when a shortcut consumes the event or the focused input receives it. */
	dispatch(event: TerminalInputEvent): boolean {
		// Terminal traffic must not insert text or interrupt an unfinished chord.
		if (event.type === "response" || event.type === "mouse") return false;
		const now = performance.now();
		if (now >= this.pendingUntil) this.pending = null;
		const key = eventToKeystroke(event);
		if (key && event.type !== "paste") {
			const contexts = [...new Set(this.targets.map(target => target.context))];
			let result = resolveKeybinding(key, contexts, this.bindings, this.pending);
			if (result.type === "cancelled") {
				this.pending = null;
				this.pendingUntil = 0;
				// Esc cancels only the chord; an invalid next key starts a fresh lookup.
				if (key.name === "escape" && !key.ctrl && !key.alt && !key.shift && !key.meta) return true;
				result = resolveKeybinding(key, contexts, this.bindings);
			}
			this.pending = result.type === "pending" ? result.chord : null;
			this.pendingUntil = this.pending ? now + CHORD_TIMEOUT_MS : 0;
			if (result.type === "pending" || result.type === "unbound") return true;
			if (result.type === "match") {
				const { context, action } = result;
				const target = this.targets.find(candidate => candidate.context === context);
				const actions = target?.actions;
				const handler = actions && Object.hasOwn(actions, action) ? actions[action] : undefined;
				if (handler && handler(event) !== false) return true;
			}
		} else {
			// Paste and multi-character blocks stay whole for the later paste handler.
			this.pending = null;
			this.pendingUntil = 0;
		}
		const onInput = this.targets[0]?.onInput;
		if (!onInput) return false;
		onInput(event);
		return true;
	}
}
