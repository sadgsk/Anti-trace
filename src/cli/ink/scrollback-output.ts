/** Find the old visible text after rewrapping, excluding borders and the temporary footer. */
function continuationLine(source: readonly string[], next: readonly string[], start: number): number | undefined {
	const text = (line: string) => line.replace(/\x1b\[[0-9;]*m/g, "").replace(/[\s│╭╮╰╯─]/g, "");
	const lengths = next.map(line => text(line).length), content = next.map(text).join("");
	for (let row = start; row < source.length - 4; row++) {
		const key = source.slice(row, Math.min(row + 3, source.length - 4)).map(text).join("");
		if (key.length < 8) continue;
		const position = content.indexOf(key);
		if (position < 0) continue;
		let offset = 0, line = 0;
		while (line < lengths.length && offset + lengths[line]! <= position) offset += lengths[line++]!;
		return line;
	}
	return undefined;
}

const SYNC_BEGIN = "\x1b[?2026h", SYNC_END = "\x1b[?2026l";
/** Move up, then overwrite rows in place and erase only what is left over.
 * Erasing first (`\x1b[J` before the rows) shows a blank region until the new rows arrive: visible flicker.
 */
function repaint(up: number, lines: readonly string[]): string {
	return `${up ? `\x1b[${up}A` : ""}\r${lines.join("\x1b[K\r\n")}\x1b[K\x1b[J`;
}

/** Ink supplies complete ANSI frames; this writer updates the visible suffix in the main buffer.
 * New lines become real terminal scrollback. No Static replay, alternate screen or scrollback erasure.
 */
export class ScrollbackOutput {
	private previous: string[] = [];
	private redraw = false;
	private replay = false;
	private reflowing = false;
	private conversation: string[] = [];
	private conversationBudget = 1;
	private columns = 0;
	private rows = 0;
	private wasConversation = true;
	constructor(private readonly stdout: NodeJS.WriteStream, private readonly isConversation: () => boolean = () => true) {}
	invalidate(): void { this.redraw = true; }
	reflow(): void { if (this.columns !== this.stdout.columns || this.rows !== this.stdout.rows) this.reflowing = true; this.redraw = true; }
	beginHistory(): void { this.replay = true; }
	write(frame: string): void {
		if (/^\x1b\[\?25[hl]$/.test(frame)) return;
		if (!frame) return;
		const next = frame.replace(/\n$/, "").split("\n"), old = this.previous;
		if (old.length && (this.columns !== this.stdout.columns || this.rows !== this.stdout.rows)) this.reflowing = true;
		// This writer leaves the cursor on the last line (no trailing newline), so all rows are visible.
		const budget = Math.max(1, this.stdout.rows || 24);
		const conversation = this.isConversation();
		// Explicit CRLF makes every logical row start in column zero, independent of terminal newline mode.
		// Every frame is one write inside a synchronized update, so terminals that support it never show a partial frame.
		let out = "";
		if (!old.length || this.replay) { out = `${old.length ? "\r\n" : ""}\x1b[?25l\r${next.join("\r\n")}`; }
		else if (this.reflowing && conversation) {
			// Preserve rows that the new wrapping would move above the visible tail.
			// They have not reached native scrollback yet, so erasing the screen would lose them.
			const source = this.conversation.length ? this.conversation : old;
			// A shorter terminal has already moved its top rows into native scrollback.
			const start = Math.max(0, source.length - Math.min(this.conversationBudget, budget)), tailStart = Math.max(0, next.length - budget);
			const canonical = (line: string) => line.replace(/\x1b\[[0-9;]*m/g, "").replace(/\s/g, "");
			const key = next.slice(tailStart, tailStart + 3).map(canonical).join("");
			const lengths = source.map(line => canonical(line).length), content = source.map(canonical).join("");
			const position = key ? content.lastIndexOf(key) : -1;
			let end = source.length;
			if (position >= 0) { let offset = 0; end = 0; while (end < lengths.length && offset + lengths[end]! <= position) offset += lengths[end++]!; if (offset < position) end++; }
			const prefix = tailStart ? source.slice(start, Math.max(start, end)) : [];
			const up = Math.min(old.length - 1, budget - 1);
			// Returning from a resized reading view must also commit the output generated in between.
			const continuation = !this.wasConversation ? continuationLine(source, next, start) : undefined;
			const lines = continuation === undefined ? [...prefix, ...next.slice(tailStart)] : next.slice(continuation);
			out = repaint(up, lines);
			this.reflowing = false;
		}
		else if (conversation && !this.wasConversation && this.conversation.length && next.length >= this.conversation.length) {
			// The reading view/menu temporarily replaced the screen. Restore the checkpoint, then
			// append everything generated while reading; printing only the new tail would omit that history.
			const checkpoint = this.conversation, up = Math.min(old.length - 1, budget - 1);
			out = repaint(up, checkpoint.slice(-budget));
			let from = Math.max(0, checkpoint.length - budget);
			while (from < checkpoint.length && checkpoint[from] === next[from]) from++;
			if (from < next.length) {
				from = Math.min(from, checkpoint.length - 1);
				const rewind = checkpoint.length - 1 - from;
				out += repaint(rewind, next.slice(from));
			}
		}
		else if (this.redraw || next.length <= old.length - budget) {
			const up = Math.min(old.length - 1, budget - 1);
			out = repaint(up, next.slice(-budget));
		} else {
			// Header metadata may change off screen. It must not cause history to be emitted again.
			let from = Math.max(0, old.length - budget);
			while (from < old.length && old[from] === next[from]) from++;
			if (from < next.length || from < old.length) {
				from = Math.min(from, old.length - 1, next.length - 1);
				const up = old.length - 1 - from;
				out = repaint(up, next.slice(from));
			}
		}
		if (out) this.stdout.write(`${SYNC_BEGIN}${out}${SYNC_END}`);
		this.previous = next; this.redraw = false; this.replay = false;
		this.columns = this.stdout.columns; this.rows = this.stdout.rows;
		if (conversation) { this.conversation = next; this.conversationBudget = budget; }
		this.wasConversation = conversation;
	}
	finish(): void { this.stdout.write("\x1b[?25h\r\n"); }
}
