import type { TerminalRows } from "./terminal-rows.ts";

/** A layout variant starts with the last known height, then measures only when visited. */
export class LazyRows implements TerminalRows {
	private rows?: TerminalRows;
	constructor(private estimate: number, private load: (() => TerminalRows) | undefined) {}
	get length(): number { return this.rows?.length ?? this.estimate; }
	ensure(): void { if (!this.rows) { this.rows = this.load!(); this.load = undefined; } }
	ensureTail(rows: number): void { this.ensure(); if (this.rows instanceof RowIndex) this.rows.ensureTail(rows); }
	ensureWindow(start: number, rows: number): void { this.ensure(); if (this.rows instanceof RowIndex) this.rows.ensureWindow(start, rows); }
	slice(start: number, end?: number): string[] { this.ensure(); return this.rows!.slice(start, end); }
}

/** Fenwick height index: locating and correcting a measured message both take O(log n). */
export class RowIndex implements TerminalRows {
	private readonly tree: number[];
	private readonly heights: number[];
	constructor(private readonly parts: readonly LazyRows[]) {
		this.heights = parts.map(part => part.length);
		this.tree = [0, ...this.heights];
		for (let i = 1; i < this.tree.length; i++) { const parent = i + (i & -i); if (parent < this.tree.length) this.tree[parent]! += this.tree[i]!; }
	}
	get length(): number { return this.top(this.parts.length); }
	top(index: number): number { let sum = 0; for (let i = index; i > 0; i -= i & -i) sum += this.tree[i]!; return sum; }
	height(index: number): number { return this.heights[index] ?? 0; }
	locate(row: number): number {
		let index = 0, sum = 0;
		for (let bit = 2 ** Math.floor(Math.log2(Math.max(1, this.parts.length))); bit; bit >>>= 1) {
			const next = index + bit;
			if (next < this.tree.length && sum + this.tree[next]! <= row) { index = next; sum += this.tree[next]!; }
		}
		return Math.min(index, this.parts.length - 1);
	}
	ensure(index: number): void {
		const part = this.parts[index]; if (!part) return;
		part.ensure(); const delta = part.length - this.heights[index]!;
		if (delta) { this.heights[index] = part.length; for (let i = index + 1; i < this.tree.length; i += i & -i) this.tree[i]! += delta; }
	}
	ensureTail(rows: number): void {
		this.ensureBefore(this.parts.length, rows);
	}
	ensureBefore(index: number, rows: number): void {
		for (let i = index - 1, remaining = rows; i >= 0 && remaining > 0; i--) { this.parts[i]!.ensureTail(remaining); this.ensure(i); remaining -= this.height(i); }
	}
	ensureFrom(index: number, rows: number, offset = 0): void {
		for (let i = Math.max(0, index), remaining = rows; i < this.parts.length && remaining > 0; i++) {
			this.parts[i]!.ensureWindow(offset, remaining); this.ensure(i); remaining -= Math.max(0, this.height(i) - offset); offset = 0;
		}
	}
	ensureWindow(start: number, rows: number): void {
		const index = this.locate(start);
		this.ensureFrom(index, rows, Math.max(0, start - this.top(index)));
	}
	slice(start: number, end?: number): string[] {
		const allRemaining = end === undefined;
		start = Math.max(0, start < 0 ? this.length + start : start);
		let remaining = allRemaining ? Infinity : Math.max(0, end - start);
		const rows: string[] = [];
		let index = this.locate(start), offset = start - this.top(index);
		for (; index >= 0 && index < this.parts.length && remaining > 0; index++) {
			this.ensure(index);
			const next = this.parts[index]!.slice(offset, allRemaining ? undefined : offset + remaining);
			this.ensure(index);
			rows.push(...next);
			remaining -= next.length; offset = 0;
		}
		return rows;
	}
}
