import { structuredPatch } from "diff";
export interface StructuredDiffHunk { oldStart: number; oldLines: number; newStart: number; newLines: number; lines: string[] }
export interface DiffDetails { hunks: StructuredDiffHunk[]; addedLines: number; removedLines: number }
export function buildDiff(path: string, before: string, after: string): DiffDetails {
	// Bound expensive diff work; an omitted hunk never prevents the file operation.
	const patch = structuredPatch(path, path, before, after, undefined, undefined, { context: 3, timeout: 500, maxEditLength: 20000 });
	const hunks = patch?.hunks ?? [];
	return { hunks, addedLines: hunks.reduce((n, h) => n + h.lines.filter(line => line.startsWith("+")).length, 0),
		removedLines: hunks.reduce((n, h) => n + h.lines.filter(line => line.startsWith("-")).length, 0) };
}
