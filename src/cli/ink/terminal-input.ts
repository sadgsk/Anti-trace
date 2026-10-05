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

/**
 * 终端按键编号速查（以下数字均为十进制）：这些编号用于 type="key" 事件的
 * 按键编码参数。parseKey 把该参数传给 fromCodepoint(value)，由它填写 key.name，
 * 必要时再填写 key.text。`CSI <key>;<modifiers>u` 用第一个参数作按键编码；
 * modifyOtherKeys 的 `CSI 27;<modifiers>;<key>~` 用第三个参数作按键编码。
 * modifiers 是另一个参数，不属于下面的编号范围。
 * 这些编号与普通 CSI/SS3 序列里的数字不是同一张表。
 *
 * 0：C0 控制码；Kitty 在只知道输入文字、不知道对应按键时也用它作 key 编号。
 * 1–31：Unicode C0 控制码；Kitty 特别把 9/13/27 用作 Tab/Enter/Esc。
 * 32–126：基本拉丁字符。32 空格；33–47 标点；48–57 数字 0–9；
 *         58–64 标点；65–90 大写 A–Z；91–96 标点；97–122 小写 a–z；
 *         123–126 标点。Kitty 用未按 Shift 的字符编号：Shift+A 仍是 97。
 * 127：DEL 控制码；Kitty 用作 Backspace。
 * 128–159：Unicode C1 控制码，不是逐个分配的物理按键。
 * 160–55295：Unicode 中的文字、符号、格式字符及未分配码位；没有按键类别分段。
 * 55296–57343：UTF-16 代理码，不能单独表示一个 Unicode 字符。
 *
 * 57344–63743：Unicode 基本多文种平面的私用区；Kitty 只分配了其中一部分：
 *   57344–57357：当前协议表未分配。
 *   57358 Caps Lock；57359 Scroll Lock；57360 Num Lock。
 *   57361 Print Screen；57362 Pause；57363 Menu。
 *   57364–57375：当前协议表未分配。
 *   57376–57398：F13–F35，编号按 F 键顺序递增。
 *   57399–57408：小键盘数字 KP_0–KP_9，编号按数字顺序递增。
 *   57409 KP_Decimal；57410 KP_Divide；57411 KP_Multiply；
 *   57412 KP_Subtract；57413 KP_Add；57414 KP_Enter；
 *   57415 KP_Equal；57416 KP_Separator。
 *   57417 KP_Left；57418 KP_Right；57419 KP_Up；57420 KP_Down；
 *   57421 KP_PageUp；57422 KP_PageDown；57423 KP_Home；57424 KP_End；
 *   57425 KP_Insert；57426 KP_Delete；57427 KP_Begin。
 *   57428 MediaPlay；57429 MediaPause；57430 MediaPlayPause；
 *   57431 MediaReverse；57432 MediaStop；57433 MediaFastForward；
 *   57434 MediaRewind；57435 MediaTrackNext；57436 MediaTrackPrevious；
 *   57437 MediaRecord；57438 LowerVolume；57439 RaiseVolume；57440 MuteVolume。
 *   57441 LeftShift；57442 LeftCtrl；57443 LeftAlt；57444 LeftSuper；
 *   57445 LeftHyper；57446 LeftMeta；57447 RightShift；57448 RightCtrl；
 *   57449 RightAlt；57450 RightSuper；57451 RightHyper；57452 RightMeta；
 *   57453 ISO_Level3_Shift；57454 ISO_Level5_Shift。
 *   57455–63743：当前协议表未分配。
 *
 * 63744–65535：其余基本多文种平面码位，不属于 Kitty 的功能键表。
 * 65536–983039：增补平面码位，如 emoji；并非 Kitty 功能键编号。
 * 983040–1048573、1048576–1114109：Unicode 增补私用区，也不属于 Kitty 功能键表。
 * 1048574–1048575、1114110–1114111：Unicode 非字符码位。
 * 小于 0 或大于 1114111 (0x10ffff)：超出 Unicode 码位范围。
 *
 * 方向键、Home/End、Insert/Delete、F1–F12 等通常使用 CSI/SS3 的
 * 字母或波浪号序列，不靠上面的大数字逐个命名。
 * 来源：https://sw.kovidgoyal.net/kitty/keyboard-protocol/#functional-key-definitions
 * Unicode：https://www.unicode.org/faq/basic_q.html
 * 修饰键与按键编号分开保存；本项目的 meta 字段对应 Kitty 的 Super 位。
 */
function parseKey(raw: string): Extract<TerminalInputEvent, { type: "key" }> {
	// 传进来的是表示按键的原始字符或字符组合；函数把它解析成 key 事件返回，事件里记录识别出的按键、同时按下的修饰键，以及可能产生的文字。
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
		if (!Number.isInteger(value) || value < 0 || value > 0x10ffff
			|| (value >= 0xd800 && value <= 0xdfff)) return;
		const special: Record<number, string> = {
			9: "tab", 13: "enter", 27: "escape", 32: "space", 127: "backspace",
			57399: "0", 57400: "1", 57401: "2", 57402: "3", 57403: "4",
			57404: "5", 57405: "6", 57406: "7", 57407: "8", 57408: "9",
		};
		key.name = special[value] ?? (value >= 57344 && value <= 63743
			? "unknown" : String.fromCodePoint(value).toLowerCase());
		const isKeypadDigit = value >= 57399 && value <= 57408;
		const isText = value >= 32 && !(value >= 127 && value <= 159)
			&& !(value >= 57344 && value <= 63743);
		if (isText || isKeypadDigit) {
			const character = isKeypadDigit ? special[value]! : String.fromCodePoint(value);
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
