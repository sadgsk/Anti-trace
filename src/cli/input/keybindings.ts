/** Names and modifiers use TerminalInputEvent conventions: Alt and Meta stay distinct. */
export interface Keystroke {
	name: string;
	ctrl?: boolean;
	alt?: boolean;
	shift?: boolean;
	meta?: boolean;
}

export interface Keybinding {
	context: string;
	chord: readonly Keystroke[];
	/** null consumes this shortcut without invoking an action. */
	action: string | null;
}

export interface PendingChord {
	context: string;
	keys: readonly Keystroke[];
}

export type KeybindingResult =
	| { type: "match"; context: string; action: string }
	| { type: "pending"; chord: PendingChord }
	| { type: "unbound"; context: string }
	| { type: "cancelled" }
	| { type: "none" };

/** The editor owns input:* actions; the REPL owns app:* actions. */
export const DEFAULT_KEYBINDINGS: readonly Keybinding[] = [
	{ context: "Global", chord: [{ name: "c", ctrl: true }], action: "app:interrupt" },
	{ context: "Input", chord: [{ name: "enter" }], action: "input:submit" },
	{ context: "Input", chord: [{ name: "enter", shift: true }], action: "input:newline" },
	// CC's legacy Meta/Option+Enter is Alt+Enter in our terminal event type.
	{ context: "Input", chord: [{ name: "enter", alt: true }], action: "input:newline" },
	{ context: "Input", chord: [{ name: "enter", meta: true }], action: "input:newline" },
	{ context: "Input", chord: [{ name: "j", ctrl: true }], action: "input:newline" },
	{ context: "Input", chord: [{ name: "left" }], action: "input:left" },
	{ context: "Input", chord: [{ name: "right" }], action: "input:right" },
	{ context: "Input", chord: [{ name: "up" }], action: "input:up" },
	{ context: "Input", chord: [{ name: "down" }], action: "input:down" },
	{ context: "Input", chord: [{ name: "backspace" }], action: "input:backspace" },
	{ context: "Input", chord: [{ name: "delete" }], action: "input:delete" },
	{ context: "Input", chord: [{ name: "home" }], action: "input:home" },
	{ context: "Input", chord: [{ name: "end" }], action: "input:end" },
	{ context: "Input", chord: [{ name: "b", ctrl: true }], action: "input:left" },
	{ context: "Input", chord: [{ name: "f", ctrl: true }], action: "input:right" },
	{ context: "Input", chord: [{ name: "p", ctrl: true }], action: "input:up" },
	{ context: "Input", chord: [{ name: "n", ctrl: true }], action: "input:down" },
	{ context: "Input", chord: [{ name: "h", ctrl: true }], action: "input:backspace" },
	{ context: "Input", chord: [{ name: "d", ctrl: true }], action: "input:delete" },
	{ context: "Input", chord: [{ name: "a", ctrl: true }], action: "input:home" },
	{ context: "Input", chord: [{ name: "e", ctrl: true }], action: "input:end" },
];

/** Omitted modifiers mean false, so Ctrl+Shift+C never matches Ctrl+C. */
export function matchesKeystroke(actual: Keystroke, expected: Keystroke): boolean {
	return actual.name === expected.name
		&& (actual.ctrl ?? false) === (expected.ctrl ?? false)
		&& (actual.alt ?? false) === (expected.alt ?? false)
		&& (actual.shift ?? false) === (expected.shift ?? false)
		&& (actual.meta ?? false) === (expected.meta ?? false);
}

/** Matches both a complete chord and a prefix that still needs more keys. */
function matchesChord(keys: readonly Keystroke[], chord: readonly Keystroke[]): boolean {
	return keys.length <= chord.length
		&& keys.every((key, index) => matchesKeystroke(key, chord[index]!));
}

/** Pure resolver. Contexts are ordered from focused scope to Global; no input is read here. */
export function resolveKeybinding(
	key: Keystroke,
	activeContexts: readonly string[],
	bindings: readonly Keybinding[],
	pending: PendingChord | null = null,
): KeybindingResult {
	// Continue only in the original context. The dispatcher must also clear pending on focus changes.
	if (pending && (!activeContexts.includes(pending.context)
		|| matchesKeystroke(key, { name: "escape" }))) {
		return { type: "cancelled" };
	}
	const keys = pending ? [...pending.keys, key] : [key];
	const contexts = pending ? [pending.context] : activeContexts;

	for (const context of contexts) {
		const winners: Keybinding[] = [];
		// The last declaration wins for the same chord, including a null override.
		for (let index = bindings.length - 1; index >= 0; index--) {
			const binding = bindings[index]!;
			if (binding.context !== context || binding.chord.length === 0
				|| !matchesChord(keys, binding.chord)) continue;
			// 同场景、同完整按键序列（含修饰键）只保留 index 最大的配置；倒序遍历时，跳过已被 winners 中后置配置覆盖的当前规则。
			if (winners.some(winner => winner.chord.length === binding.chord.length
				&& matchesChord(winner.chord, binding.chord))) continue;
			winners.push(binding);
		}

		// Like CC, prefer waiting for a longer chord over firing its shorter prefix.
		if (winners.some(binding => binding.action !== null && binding.chord.length > keys.length)) {
			return {
				type: "pending",
				chord: {
					context,
					keys: keys.map(stroke => ({
						name: stroke.name,
						ctrl: stroke.ctrl ?? false,
						alt: stroke.alt ?? false,
						shift: stroke.shift ?? false,
						meta: stroke.meta ?? false,
					})),
				},
			};
		}
		const exact = winners.find(binding => binding.chord.length === keys.length);
		if (exact) {
			return exact.action === null
				? { type: "unbound", context }
				: { type: "match", context, action: exact.action };
		}
	}
	return { type: pending ? "cancelled" : "none" };
}
