import { StringDecoder } from "node:string_decoder";

const ESC = "\x1b";
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

export type TerminalInputEvent =
	| { type: "text"; text: string }
	| {
			type: "key";
			name: string;
			raw: string;
			text?: string;
			ctrl: boolean;
			alt: boolean;
			shift: boolean;
			meta: boolean;
		}
	| { type: "paste"; text: string; isPasted: true }
	| { type: "response"; raw: string }
	| { type: "mouse"; raw: string };

const CSI_KEYS: Record<string, string> = {
	A: "up", B: "down", C: "right", D: "left", H: "home", F: "end",
	P: "f1", Q: "f2", R: "f3", S: "f4",
};
const TILDE_KEYS: Record<string, string> = {
	"1": "home", "2": "insert", "3": "delete", "4": "end",
	"5": "pageup", "6": "pagedown", "7": "home", "8": "end",
	"11": "f1", "12": "f2", "13": "f3", "14": "f4", "15": "f5",
	"17": "f6", "18": "f7", "19": "f8", "20": "f9", "21": "f10",
	"23": "f11", "24": "f12",
};
const SS3_KEYS: Record<string, string> = {
	A: "up", B: "down", C: "right", D: "left", H: "home", F: "end",
	P: "f1", Q: "f2", R: "f3", S: "f4", M: "enter",
};

/** Decodes terminal bytes into events without reading stdin itself. */
export class TerminalInputParser {
	private readonly decoder = new StringDecoder("utf8");
	private pending = "";
	private paste = "";
	private inPaste = false;
	private skipLf = false;
	/** Only ambiguous or incomplete non-paste escapes need a timeout. */
	awaitingEscape = false;
	awaitingPaste = false;

	/** Pass null to resolve a timed-out escape without ending UTF-8 decoding. */
	feed(chunk: Buffer | null): TerminalInputEvent[] {
		const final = chunk === null;
		if (chunk !== null) this.pending += this.decoder.write(chunk);
		const events: TerminalInputEvent[] = [];
		this.awaitingEscape = false;
		this.awaitingPaste = false;

		while (this.pending.length > 0) {
			if (this.inPaste) {
				const end = this.pending.indexOf(PASTE_END);
				if (end >= 0) {
					this.paste += this.pending.slice(0, end);
					this.pending = this.pending.slice(end + PASTE_END.length);
					events.push({ type: "paste", text: this.paste, isPasted: true });
					this.paste = "";
					this.inPaste = false;
					continue;
				}
				if (final) {
					this.paste += this.pending;
					this.pending = "";
					if (this.paste) events.push({ type: "paste", text: this.paste, isPasted: true });
					this.paste = "";
					this.inPaste = false;
					break;
				}
				// Keep enough characters for an end marker split across chunks.
				const safe = Math.max(0, this.pending.length - PASTE_END.length + 1);
				this.paste += this.pending.slice(0, safe);
				this.pending = this.pending.slice(safe);
				break;
			}

			if (this.skipLf) {
				this.skipLf = false;
				if (this.pending[0] === "\n") {
					this.pending = this.pending.slice(1);
					continue;
				}
			}

			if (this.pending[0] !== ESC) {
				const control = this.pending.search(/[\x00-\x1f\x7f]/);
				if (control !== 0) {
					const end = control < 0 ? this.pending.length : control;
					events.push({ type: "text", text: this.pending.slice(0, end) });
					this.pending = this.pending.slice(end);
					continue;
				}
				const raw = this.pending[0]!;
				this.pending = this.pending.slice(1);
				if (raw === "\r") this.skipLf = true;
				events.push(parseKey(raw));
				continue;
			}

			// A leading ESC may itself be a key, or prefix an Alt key or sequence.
			const offset = this.pending[1] === ESC ? 1 : 0;
			const prefix = this.pending.slice(offset);
			if (prefix.length === 1) {
				if (!final) break;
				events.push(parseKey(this.pending));
				this.pending = "";
				break;
			}

			let end = -1;
			const introducer = prefix[1];
			if (introducer === "[") {
				if (prefix.startsWith("\x1b[[")) {
					if (prefix.length >= 4) end = offset + 4;
				} else {
					for (let i = 2; i < prefix.length; i++) {
						const code = prefix.charCodeAt(i);
						if (code >= 0x40 && code <= 0x7e) {
							end = offset + i + 1;
							break;
						}
						if (code < 0x20 || code > 0x3f) {
							end = offset + i;
							break;
						}
					}
				}
			} else if (introducer === "O") {
				if (prefix.length >= 3) end = offset + 3;
			} else if (introducer === "]" || introducer === "P" || introducer === "_") {
				const bell = prefix.indexOf("\x07", 2);
				const st = prefix.indexOf("\x1b\\", 2);
				if (bell >= 0 || st >= 0) {
					end = offset + (bell >= 0 && (st < 0 || bell < st) ? bell + 1 : st + 2);
				}
			} else {
				end = offset + 1 + String.fromCodePoint(prefix.codePointAt(1)!).length;
			}

			if (end < 0) {
				if (!final) break;
				// An unfinished sequence is one unknown key, never printable escape debris.
				events.push(parseKey(this.pending));
				this.pending = "";
				break;
			}
			// X10 mouse packets are CSI M followed by three payload bytes.
			if (this.pending.slice(0, end) === "\x1b[M") {
				if (this.pending.length < end + 3 && !final) break;
				end = Math.min(this.pending.length, end + 3);
			}
			const raw = this.pending.slice(0, end);
			this.pending = this.pending.slice(end);
			if (raw === PASTE_START) {
				this.inPaste = true;
				this.paste = "";
			} else if (raw === PASTE_END) {
				// Ignore a stray closing marker.
			} else if (/^\x1b(?:\]|P|_)/.test(raw) || /^\x1b\[(?:\?|>)/.test(raw)) {
				events.push({ type: "response", raw });
			} else if (/^\x1b\[<\d+;\d+;\d+[Mm]$/.test(raw)) {
				events.push({ type: "mouse", raw });
			} else if (raw.startsWith("\x1b[M")) {
				events.push({ type: "mouse", raw });
			} else {
				events.push(parseKey(raw));
			}
		}

		this.awaitingEscape = !final && !this.inPaste && this.pending.startsWith(ESC);
		this.awaitingPaste = !final && this.inPaste;
		return events;
	}
}

/** Keep physical modifiers separate; Meta is Kitty's Cmd/Win bit, Alt its own bit. */
function parseKey(raw: string): Extract<TerminalInputEvent, { type: "key" }> {
	let sequence = raw;
	let alt = false;
	if (sequence.startsWith("\x1b\x1b")) {
		sequence = sequence.slice(1);
		alt = true;
	}
	const key: Extract<TerminalInputEvent, { type: "key" }> = {
		type: "key", name: "unknown", raw, ctrl: false, alt, shift: false, meta: false,
	};
	const setModifiers = (value: number): void => {
		if (!Number.isInteger(value) || value < 1) return;
		const bits = value - 1;
		key.shift = (bits & 1) !== 0;
		key.alt ||= (bits & 2) !== 0;
		key.ctrl = (bits & 4) !== 0;
		key.meta = (bits & 8) !== 0;
	};
	const fromCodepoint = (value: number): void => {
		if (!Number.isInteger(value) || value < 0 || value > 0x10ffff) return;
		const special: Record<number, string> = {
			9: "tab", 13: "enter", 27: "escape", 32: "space", 127: "backspace",
			57399: "0", 57400: "1", 57401: "2", 57402: "3", 57403: "4",
			57404: "5", 57405: "6", 57406: "7", 57407: "8", 57408: "9",
		};
		key.name = special[value] ?? (value >= 57344 && value <= 63743
			? "unknown" : String.fromCodePoint(value).toLowerCase());
		if (value >= 32 && value !== 127 && value < 57399) {
			const character = String.fromCodePoint(value);
			key.text = key.shift && /^[a-z]$/.test(character) ? character.toUpperCase() : character;
		}
	};

	if (sequence === ESC) key.name = "escape";
	else if (sequence === "\r" || sequence === "\n") key.name = "enter";
	else if (sequence === "\t") key.name = "tab";
	else if (sequence === "\x7f" || sequence === "\b") key.name = "backspace";
	else if (sequence.length === 1 && sequence.charCodeAt(0) >= 1 && sequence.charCodeAt(0) <= 26) {
		key.name = String.fromCharCode(sequence.charCodeAt(0) + 96);
		key.ctrl = true;
	} else if (sequence === "\x1f") {
		key.name = "_";
		key.ctrl = true;
	} else if (/^\x1b\[\d+(?:;\d+)?u$/.test(sequence)) {
		const match = /^\x1b\[(\d+)(?:;(\d+))?u$/.exec(sequence)!;
		setModifiers(Number(match[2] ?? "1"));
		fromCodepoint(Number(match[1]));
	} else if (/^\x1b\[27;\d+;\d+~$/.test(sequence)) {
		const match = /^\x1b\[27;(\d+);(\d+)~$/.exec(sequence)!;
		setModifiers(Number(match[1]));
		fromCodepoint(Number(match[2]));
	} else if (sequence.startsWith("\x1b[")) {
		const body = sequence.slice(2);
		if (body === "Z") {
			key.name = "tab";
			key.shift = true;
		} else if (/^\[?[A-DHFPQRS]$/.test(body)) {
			key.name = body.startsWith("[") ? `f${"ABCD".indexOf(body[1]!) + 1}` : CSI_KEYS[body] ?? "unknown";
		} else {
			const match = /^(\d+)(?:;(\d+))?([A-DFHP-S~])$/.exec(body);
			if (match) {
				setModifiers(Number(match[2] ?? "1"));
				key.name = match[3] === "~" ? TILDE_KEYS[match[1]!] ?? "unknown" : CSI_KEYS[match[3]!] ?? "unknown";
			}
		}
	} else if (sequence.startsWith("\x1bO") && sequence.length === 3) {
		key.name = SS3_KEYS[sequence[2]!] ?? "unknown";
	} else if (sequence.startsWith(ESC) && sequence.length > 1) {
		key.alt = true;
		const character = sequence.slice(1);
		if (character === "\x7f" || character === "\b") key.name = "backspace";
		else if (character === "\r") key.name = "enter";
		else if (character === "\t") key.name = "tab";
		else if (character === ESC) key.name = "escape";
		else if ([...character].length === 1) {
			key.name = character.toLowerCase();
			key.shift = /^[A-Z]$/.test(character);
			key.text = character;
		}
	}
	return key;
}
