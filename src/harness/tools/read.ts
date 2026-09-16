import { readFile } from "node:fs/promises";
import { type Static, Type } from "typebox";
import type { AgentTool } from "../../types.ts";
import { resolveCwdPath } from "./path-utils.ts";

const DEFAULT_MAX_LINES = 2000;
const DEFAULT_MAX_BYTES = 50 * 1024;

export const readSchema = Type.Object({
	path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
	offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-indexed)" })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
});

export type ReadToolInput = Static<typeof readSchema>;

export interface ReadToolDetails {
	path: string;
	totalLines: number;
	startLine: number;
	endLine: number;
	truncated?: boolean;
}

export function createReadTool(cwd: string): AgentTool<typeof readSchema, ReadToolDetails> {
	return {
		name: "read",
		label: "read",
		description: `Read the contents of a text file. Output is truncated to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Use offset/limit for large files. When you need the full file, continue with offset until complete.`,
		parameters: readSchema,
		async execute(_toolCallId, { path: inputPath, offset, limit }, signal) {
			const absolutePath = await resolveCwdPath(cwd, inputPath, signal);

			let text: string;
			try {
				text = await readFile(absolutePath, { encoding: "utf8", signal });
			} catch (error) {
				if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) {
					throw new Error("Aborted");
				}
				if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
					throw new Error(`File not found: ${inputPath}`);
				}
				throw error;
			}

			const allLines = text.replace(/\r\n/g, "\n").split("\n");
			const totalLines = allLines.length;
			const startLine = offset ? Math.max(0, offset - 1) : 0;
			if (startLine >= allLines.length) {
				throw new Error(`Offset ${offset} is beyond end of file (${totalLines} lines total)`);
			}

			const selectedLines =
				limit !== undefined ? allLines.slice(startLine, startLine + limit) : allLines.slice(startLine);

			let keptLines = selectedLines;
			let truncated = false;
			let truncatedBy: "lines" | "bytes" | null = null;
			let firstLineExceedsLimit = false;
			const firstLineBytes = Buffer.byteLength(selectedLines[0] ?? "", "utf8");
			if (firstLineBytes > DEFAULT_MAX_BYTES) {
				keptLines = [];
				truncated = true;
				truncatedBy = "bytes";
				firstLineExceedsLimit = true;
			} else {
				const fitted: string[] = [];
				let usedBytes = 0;
				for (let i = 0; i < selectedLines.length && i < DEFAULT_MAX_LINES; i++) {
					const extra = i > 0 ? 1 : 0;
					const lineBytes = Buffer.byteLength(selectedLines[i], "utf8") + extra;
					if (usedBytes + lineBytes > DEFAULT_MAX_BYTES) {
						truncated = true;
						truncatedBy = "bytes";
						break;
					}
					fitted.push(selectedLines[i]);
					usedBytes += lineBytes;
				}
				if (fitted.length < selectedLines.length && truncatedBy === null) {
					truncated = true;
					truncatedBy = "lines";
				}
				keptLines = fitted;
			}

			const startLineDisplay = startLine + 1;
			const endLineDisplay = keptLines.length === 0 ? startLineDisplay - 1 : startLineDisplay + keptLines.length - 1;
			const width = String(Math.max(endLineDisplay, startLineDisplay)).length;
			const numbered = keptLines
				.map((line, index) => `${String(startLineDisplay + index).padStart(width)}|${line}`)
				.join("\n");

			let outputText: string;
			if (firstLineExceedsLimit) {
				outputText = `[Line ${startLineDisplay} exceeds ${DEFAULT_MAX_BYTES / 1024}KB limit.]`;
			} else if (truncated) {
				const nextOffset = endLineDisplay + 1;
				const reason =
					truncatedBy === "lines"
						? `Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalLines}.`
						: `Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalLines} (${DEFAULT_MAX_BYTES / 1024}KB limit).`;
				outputText = `${numbered}\n\n[${reason} Use offset=${nextOffset} to continue.]`;
			} else if (limit !== undefined && startLine + selectedLines.length < totalLines) {
				const remaining = totalLines - (startLine + selectedLines.length);
				const nextOffset = startLine + selectedLines.length + 1;
				outputText = `${numbered}\n\n[${remaining} more lines in file. Use offset=${nextOffset} to continue.]`;
			} else {
				outputText = numbered;
			}

			return {
				content: [{ type: "text", text: outputText }],
				details: {
					path: absolutePath,
					totalLines,
					startLine: startLineDisplay,
					endLine: endLineDisplay,
					truncated: truncated || undefined,
				},
			};
		},
	};
}
