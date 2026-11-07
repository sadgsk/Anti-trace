import type { TranscriptAnchor } from "../viewport-state.ts";
/** Random access to laid-out terminal rows. Reading a viewport never joins the transcript. */
export interface TerminalRows {
	readonly length: number;
	slice(start: number, end?: number): string[];
	anchor?(row: number): TranscriptAnchor | undefined;
	resolve?(anchor: TranscriptAnchor): number | undefined;
}

export class ArrayRows implements TerminalRows {
	constructor(private readonly rows: readonly string[]) {}
	get length(): number { return this.rows.length; }
	slice(start: number, end = this.length): string[] { return this.rows.slice(start, end); }
}

/** A physical-screen checkpoint keeps only the rows that can still be overwritten. */
export function tailRows(source: TerminalRows, budget: number): TerminalRows {
	const length = source.length, base = Math.max(0, length - budget), rows = source.slice(base);
	const anchors = rows.map((_, i) => source.anchor?.(base + i));
	return { length, anchor: row => anchors[row - base], slice: (start, end = length) => rows.slice(Math.max(0, (start < 0 ? length + start : start) - base), Math.max(0, end - base)) };
}

/** Appending a footer to a lazy transcript must observe height corrections during a history replay. */
export function appendRows(history: TerminalRows, footer: readonly string[]): TerminalRows {
	return {
		get length() { return history.length + footer.length; },
		anchor: row => history.anchor?.(Math.min(row, Math.max(0, history.length - 1))),
		resolve: anchor => history.resolve?.(anchor),
		slice(start, end) {
			start = Math.max(0, start < 0 ? this.length + start : start);
			if (end === undefined) {
				const rows = start < history.length ? history.slice(start) : [];
				return rows.concat(footer.slice(Math.max(0, start - history.length)));
			}
			const rows = start < history.length ? history.slice(start, Math.min(end, history.length)) : [];
			return rows.concat(footer.slice(Math.max(0, start - history.length), Math.max(0, end - history.length)));
		},
	};
}

/** Leaf animations are already present in Ink's bounded viewport; overlay them without touching cached layouts. */
export function overlayTail(history: TerminalRows, viewport: readonly string[]): TerminalRows {
	return {
		get length() { return history.length; },
		anchor: row => history.anchor?.(row), resolve: anchor => history.resolve?.(anchor),
		slice(start, end) {
			start = Math.max(0, start < 0 ? history.length + start : start);
			if (end === undefined) {
				const rows = history.slice(start), count = Math.min(history.length, viewport.length);
				const base = history.length - count;
				return rows.slice(0, Math.max(0, base - start)).concat(viewport.slice(Math.max(0, start - base), count));
			}
			const count = Math.min(history.length, viewport.length), base = history.length - count;
			const prefix = start < base ? history.slice(start, Math.min(end, base)) : [];
			return prefix.concat(viewport.slice(Math.max(0, start - base), Math.min(count, Math.max(0, end - base))));
		},
	};
}
