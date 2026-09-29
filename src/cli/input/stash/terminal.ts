import { stdin, stdout } from "node:process";
import type { Readable, Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";

const ENABLE_BRACKETED_PASTE = "\x1b[?2004h";
const DISABLE_BRACKETED_PASTE = "\x1b[?2004l";
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";
const ESCAPE_DELAY_MS = 250;

export type TerminalKey =
	| "enter"
	| "backspace"
	| "delete"
	| "left"
	| "right"
	| "up"
	| "down"
	| "home"
	| "end"
	| "page-up"
	| "page-down"
	| "insert"
	| "tab"
	| "escape"
	| "ctrl-c"
	| "ctrl-d"
	| "ctrl-j"
	| "ctrl-g"
	| "ctrl-v"
	| "ctrl-a"
	| "ctrl-e"
	| "ctrl-k"
	| "ctrl-u"
	| "ctrl-w"
	| "ctrl-l"
	| "alt-v"
	| "unknown";

export type TerminalInputEvent =
	| { type: "text"; text: string }
	| {
			type: "key";
			key: TerminalKey;
			raw: string;
			ctrl: boolean;
			alt: boolean;
			shift: boolean;
		}
	| { type: "paste"; text: string }
	| { type: "end" };

export type TerminalInputStream = Readable & {
	isTTY?: boolean;
	isRaw?: boolean;
	setRawMode?: (mode: boolean) => void;
};

export interface TerminalInputOptions {
	input?: TerminalInputStream;
	output?: Writable;
	onEvent: (event: TerminalInputEvent) => void;
}

type KeyModifiers = { ctrl: boolean; alt: boolean; shift: boolean };
const NO_MODIFIERS: KeyModifiers = { ctrl: false, alt: false, shift: false };

/**
 * Owns the byte stream and turns terminal input into text, key, and atomic paste
 * events. In a non-TTY pipeline, the complete input is emitted as one paste at
 * EOF, followed by `end`; a newline in piped data never acts as Enter.
 */
export class TerminalInput {
	private readonly input: TerminalInputStream;
	private readonly output: Writable;
	private readonly onEvent: (event: TerminalInputEvent) => void;
	private decoder = new StringDecoder("utf8");
	private started = false;
	private wasRaw = false;
	private tty = false;
	private bracketed = false;
	private pending = "";
	private paste = "";
	private inPaste = false;
	private escapeTimer: NodeJS.Timeout | undefined;
	private skipNextLF = false;

	constructor(options: TerminalInputOptions) {
		this.input = options.input ?? stdin;
		this.output = options.output ?? stdout;
		this.onEvent = options.onEvent;
	}

	start(): void {
		if (this.started) return;
		this.decoder = new StringDecoder("utf8");
		this.pending = "";
		this.paste = "";
		this.inPaste = false;
		this.skipNextLF = false;
		this.tty = this.input.isTTY === true;
		this.bracketed = this.tty && (this.output as Writable & { isTTY?: boolean }).isTTY === true;
		this.wasRaw = this.input.isRaw === true;
		if (this.tty && typeof this.input.setRawMode !== "function") {
			throw new Error("TTY input does not support setRawMode");
		}

		this.started = true;
		try {
			this.input.on("data", this.handleData);
			this.input.once("end", this.handleEnd);
			if (this.tty) {
				this.input.setRawMode?.(true);
				if (this.bracketed) this.output.write(ENABLE_BRACKETED_PASTE);
			}
			this.input.resume();
		} catch (error) {
			this.stop();
			throw error;
		}
	}

	stop(): void {
		if (!this.started) return;
		this.started = false;
		this.input.off("data", this.handleData);
		this.input.off("end", this.handleEnd);
		this.clearEscapeTimer();
		if (this.tty) {
			try {
				if (this.bracketed) this.output.write(DISABLE_BRACKETED_PASTE);
			} finally {
				this.input.setRawMode?.(this.wasRaw);
			}
		}
	}

	private readonly handleData = (chunk: Buffer | string): void => {
		if (!this.started) return;
		const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
		this.pending += this.decoder.write(bytes);
		if (this.tty) this.drain(false);
	};

	private readonly handleEnd = (): void => {
		if (!this.started) return;
		this.pending += this.decoder.end();
		if (this.tty) {
			this.drain(true);
			if (this.inPaste) {
				this.paste += this.pending;
				this.pending = "";
				this.finishPaste();
			}
		} else if (this.pending.length > 0) {
			this.onEvent({ type: "paste", text: cleanPaste(this.pending) });
		}
		this.stop();
		this.onEvent({ type: "end" });
	};

	private drain(final: boolean): void {
		while (this.pending.length > 0 && this.started) {
			if (this.inPaste) {
				const end = this.pending.indexOf(PASTE_END);
				if (end >= 0) {
					this.paste += this.pending.slice(0, end);
					this.pending = this.pending.slice(end + PASTE_END.length);
					this.finishPaste();
					continue;
				}
				if (final) {
					this.paste += this.pending;
					this.pending = "";
					this.finishPaste();
					continue;
				}
				const safeLength = Math.max(0, this.pending.length - PASTE_END.length + 1);
				this.paste += this.pending.slice(0, safeLength);
				this.pending = this.pending.slice(safeLength);
				return;
			}

			if (this.pending[0] === "\x1b") {
				this.skipNextLF = false;
				if (!this.consumeEscape(final)) {
					// A paste delimiter can span arbitrarily many chunks. Do not
					// time out a recognized prefix while waiting for its last bytes.
					if (this.pending.length > 1 && (PASTE_START.startsWith(this.pending) || PASTE_END.startsWith(this.pending))) {
						this.clearEscapeTimer();
					} else {
						this.scheduleEscapeTimer();
					}
					return;
				}
				this.clearEscapeTimer();
				continue;
			}

			const character = String.fromCodePoint(this.pending.codePointAt(0)!);
			this.pending = this.pending.slice(character.length);
			if (this.skipNextLF && character === "\n") {
				this.skipNextLF = false;
				continue;
			}
			this.skipNextLF = false;
			this.consumeCharacter(character);
		}
	}

	private consumeEscape(final: boolean): boolean {
		if (this.pending.length === 1) {
			if (!final) return false;
			this.pending = "";
			this.emitKey("escape", "\x1b");
			return true;
		}
		if (this.pending[1] === "[") {
			let end = 2;
			while (end < this.pending.length) {
				const code = this.pending.charCodeAt(end);
				if (code >= 0x40 && code <= 0x7e) break;
				end++;
			}
			if (end === this.pending.length) {
				if (!final) return false;
				this.pending = this.pending.slice(1);
				this.emitKey("escape", "\x1b");
				return true;
			}
			const raw = this.pending.slice(0, end + 1);
			this.pending = this.pending.slice(end + 1);
			if (raw === PASTE_START) {
				this.inPaste = true;
				this.paste = "";
			} else if (raw !== PASTE_END) {
				this.consumeCSI(raw);
			}
			return true;
		}
		if (this.pending[1] === "O") {
			if (this.pending.length < 3) {
				if (!final) return false;
				this.pending = this.pending.slice(1);
				this.emitKey("escape", "\x1b");
				return true;
			}
			const raw = this.pending.slice(0, 3);
			this.pending = this.pending.slice(3);
			const key = ({ A: "up", B: "down", C: "right", D: "left", H: "home", F: "end" } as const)[raw[2] as "A"];
			this.emitKey(key ?? "unknown", raw);
			return true;
		}
		const character = String.fromCodePoint(this.pending.codePointAt(1)!);
		this.pending = this.pending.slice(1 + character.length);
		this.emitKey(character.toLowerCase() === "v" ? "alt-v" : "unknown", `\x1b${character}`, {
			ctrl: false,
			alt: true,
			shift: character !== character.toLowerCase(),
		});
		return true;
	}

	private consumeCSI(raw: string): void {
		const final = raw.at(-1)!;
		const parameters = raw.slice(2, -1).split(";");
		if (final === "Z") {
			this.emitKey("tab", raw, { ctrl: false, alt: false, shift: true });
			return;
		}
		const mods = decodeModifiers(parameters[1]);
		if (final === "u") {
			this.consumeModifiedCharacter(Number(parameters[0]), raw, mods);
			return;
		}
		if (final === "~") {
			if (parameters[0] === "27" && parameters.length >= 3) {
				this.consumeModifiedCharacter(Number(parameters[2]), raw, mods);
				return;
			}
			const key = ({ "1": "home", "2": "insert", "3": "delete", "4": "end", "5": "page-up", "6": "page-down", "7": "home", "8": "end" } as Record<string, TerminalKey>)[parameters[0]];
			this.emitKey(key ?? "unknown", raw, mods);
			return;
		}
		const key = ({ A: "up", B: "down", C: "right", D: "left", H: "home", F: "end" } as Record<string, TerminalKey>)[final];
		this.emitKey(key ?? "unknown", raw, mods);
	}

	private consumeModifiedCharacter(codePoint: number, raw: string, mods: KeyModifiers): void {
		if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) {
			this.emitKey("unknown", raw, mods);
			return;
		}
		const character = String.fromCodePoint(codePoint);
		if (mods.ctrl) {
			const ctrlKey = ({ a: "ctrl-a", c: "ctrl-c", d: "ctrl-d", e: "ctrl-e", g: "ctrl-g", j: "ctrl-j", k: "ctrl-k", l: "ctrl-l", u: "ctrl-u", v: "ctrl-v", w: "ctrl-w" } as Record<string, TerminalKey>)[character.toLowerCase()];
			if (ctrlKey) {
				this.emitKey(ctrlKey, raw, mods);
				return;
			}
		}
		if (mods.alt && character.toLowerCase() === "v") {
			this.emitKey("alt-v", raw, mods);
			return;
		}
		const key = ({ "\r": "enter", "\n": "ctrl-j", "\t": "tab", "\x1b": "escape", "\x7f": "backspace" } as Record<string, TerminalKey>)[character];
		if (key) {
			this.emitKey(key, raw, mods);
		} else if (!mods.ctrl && !mods.alt) {
			this.onEvent({ type: "text", text: character });
		} else {
			this.emitKey("unknown", raw, mods);
		}
	}

	private consumeCharacter(character: string): void {
		switch (character) {
			case "\r":
				this.skipNextLF = true;
				this.emitKey("enter", character);
				return;
			case "\n": this.emitKey("ctrl-j", character); return;
			case "\t": this.emitKey("tab", character); return;
			case "\x7f":
			case "\b": this.emitKey("backspace", character); return;
			case "\x03": this.emitKey("ctrl-c", character, { ctrl: true, alt: false, shift: false }); return;
			case "\x04": this.emitKey("ctrl-d", character, { ctrl: true, alt: false, shift: false }); return;
			case "\x07": this.emitKey("ctrl-g", character, { ctrl: true, alt: false, shift: false }); return;
			case "\x16": this.emitKey("ctrl-v", character, { ctrl: true, alt: false, shift: false }); return;
			case "\x01": this.emitKey("ctrl-a", character, { ctrl: true, alt: false, shift: false }); return;
			case "\x05": this.emitKey("ctrl-e", character, { ctrl: true, alt: false, shift: false }); return;
			case "\x0b": this.emitKey("ctrl-k", character, { ctrl: true, alt: false, shift: false }); return;
			case "\x0c": this.emitKey("ctrl-l", character, { ctrl: true, alt: false, shift: false }); return;
			case "\x15": this.emitKey("ctrl-u", character, { ctrl: true, alt: false, shift: false }); return;
			case "\x17": this.emitKey("ctrl-w", character, { ctrl: true, alt: false, shift: false }); return;
		}
		if (character.charCodeAt(0) < 0x20 || character.charCodeAt(0) === 0x7f) {
			this.emitKey("unknown", character);
		} else {
			this.onEvent({ type: "text", text: character });
		}
	}

	private emitKey(key: TerminalKey, raw: string, mods: KeyModifiers = NO_MODIFIERS): void {
		this.onEvent({ type: "key", key, raw, ...mods });
	}

	private finishPaste(): void {
		const text = cleanPaste(this.paste);
		this.paste = "";
		this.inPaste = false;
		this.onEvent({ type: "paste", text });
	}

	private scheduleEscapeTimer(): void {
		if (this.escapeTimer) return;
		this.escapeTimer = setTimeout(() => {
			this.escapeTimer = undefined;
			if (!this.started || this.pending[0] !== "\x1b") return;
			this.pending = this.pending.slice(1);
			this.emitKey("escape", "\x1b");
			this.drain(false);
		}, ESCAPE_DELAY_MS);
	}

	private clearEscapeTimer(): void {
		if (!this.escapeTimer) return;
		clearTimeout(this.escapeTimer);
		this.escapeTimer = undefined;
	}
}

function decodeModifiers(parameter: string | undefined): KeyModifiers {
	const value = Number(parameter ?? "1") - 1;
	if (!Number.isInteger(value) || value < 0) return NO_MODIFIERS;
	return { shift: (value & 1) !== 0, alt: (value & 2) !== 0, ctrl: (value & 4) !== 0 };
}

function cleanPaste(text: string): string {
	return text.replace(/\r\n?/g, "\n").replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
}
