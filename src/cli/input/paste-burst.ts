/**
 * A best-effort fallback for terminals that send a paste as ordinary key events.
 * Bracketed paste is handled by TerminalInput and never passes through this class.
 *
 * The classifier only observes event order and time. No timing rule can distinguish
 * every unmarked paste from someone typing the same keys, so callers should also
 * offer an explicit multiline input path on terminals without paste reporting.
 */

export type BurstDelimiter = "enter" | "tab";

export type BurstOutput =
	| { type: "text"; text: string }
	| { type: "paste"; text: string }
	| { type: "key"; key: BurstDelimiter };

export interface PasteBurstOptions {
	/** Maximum gap between characters before considering them one fast sequence. */
	characterGapMs?: number;
	/** How long to wait for the next piece of an active unmarked paste. */
	burstIdleMs?: number;
	/** Keep a trailing Enter from submitting just after an inferred paste. */
	enterGuardMs?: number;
}

export class PasteBurst {
	readonly #characterGapMs: number;
	readonly #burstIdleMs: number;
	readonly #enterGuardMs: number;
	#pending = "";
	#pendingCharCount = 0;
	#pendingEnter = false;
	#lastAt = 0;
	#burst = false;
	#enterGuardUntil = 0;

	constructor(options: PasteBurstOptions = {}) {
		this.#characterGapMs = options.characterGapMs ?? 8;
		this.#burstIdleMs = options.burstIdleMs ?? (process.platform === "win32" ? 60 : 16);
		this.#enterGuardMs = options.enterGuardMs ?? 120;
	}

	/** The next time the owner should call flushIfDue(), or undefined when idle. */
	get deadline(): number | undefined {
		if (this.#pending.length === 0) {
			return undefined;
		}
		return this.#lastAt + (this.#burst ? this.#burstIdleMs : this.#characterGapMs);
	}

	feedText(text: string, now: number): BurstOutput[] {
		if (text.length === 0) {
			return [];
		}
		const output = this.flushIfDue(now);
		const closeToPrevious = this.#pending.length > 0 && now - this.#lastAt <= this.#characterGapMs;
		if (this.#pendingEnter) {
			// A newline followed immediately by text is an unmarked paste prefix.
			this.#pendingEnter = false;
			this.#burst = true;
		}
		this.#pending += text;
		const addedCount = [...text].length;
		this.#pendingCharCount += addedCount;
		this.#lastAt = now;
		if (closeToPrevious && this.#pendingCharCount >= 3) {
			this.#burst = true;
		}
		// A terminal may deliver several characters in one decoded text event.
		if (addedCount >= 3) {
			this.#burst = true;
		}
		return output;
	}

	feedDelimiter(key: BurstDelimiter, now: number): BurstOutput[] {
		const output = this.flushIfDue(now);
		if (this.#burst && now - this.#lastAt <= this.#burstIdleMs) {
			this.#pending += key === "enter" ? "\n" : "\t";
			this.#pendingCharCount += 1;
			this.#lastAt = now;
			return output;
		}
		if (key === "enter" && now < this.#enterGuardUntil) {
			output.push({ type: "paste", text: "\n" });
			return output;
		}
		if (this.#pending.length > 0 && now - this.#lastAt <= this.#characterGapMs) {
			// Conservatively treat a fast one- or two-character prefix plus Enter
			// as paste. The next separate Enter still submits after the idle window.
			this.#pending += key === "enter" ? "\n" : "\t";
			this.#pendingCharCount += 1;
			this.#pendingEnter = false;
			this.#burst = true;
			this.#lastAt = now;
			return output;
		}
		if (key === "enter") {
			// Hold a bare Enter very briefly so a paste beginning with a newline
			// can be recognized when its next character arrives.
			this.#pending = "\n";
			this.#pendingCharCount = 1;
			this.#pendingEnter = true;
			this.#lastAt = now;
			return output;
		}
		output.push(...this.flushAll(now), { type: "key", key });
		return output;
	}

	/** Flush buffered typing before a cursor movement, shortcut, or explicit paste. */
	flushAll(now: number): BurstOutput[] {
		if (this.#pending.length === 0) {
			return [];
		}
		const value = this.#pending;
		const wasBurst = this.#burst;
		const wasEnter = this.#pendingEnter;
		this.#pending = "";
		this.#pendingCharCount = 0;
		this.#pendingEnter = false;
		this.#burst = false;
		if (wasBurst) {
			this.#enterGuardUntil = now + this.#enterGuardMs;
		}
		return wasEnter
			? [{ type: "key", key: "enter" }]
			: [{ type: wasBurst ? "paste" : "text", text: value }];
	}

	flushIfDue(now: number): BurstOutput[] {
		const deadline = this.deadline;
		return deadline !== undefined && now >= deadline ? this.flushAll(now) : [];
	}

	reset(): void {
		this.#pending = "";
		this.#pendingCharCount = 0;
		this.#pendingEnter = false;
		this.#burst = false;
		this.#enterGuardUntil = 0;
	}
}
