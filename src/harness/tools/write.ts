import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { type Static, Type } from "typebox";
import type { AgentTool } from "../../types.ts";
import { resolveCwdPath } from "./path-utils.ts";
import { buildDiff, type StructuredDiffHunk } from "./diff.ts";

export const writeSchema = Type.Object({
	path: Type.String({ description: "Path to the file to write (relative or absolute)" }),
	content: Type.String({ description: "Content to write to the file" }),
});

export type WriteToolInput = Static<typeof writeSchema>;

export interface WriteToolDetails {
	path: string;
	bytes: number;
	created: boolean;
	lineCount: number;
	previewLines: string[];
	hunks?: StructuredDiffHunk[];
	addedLines?: number;
	removedLines?: number;
}

export function createWriteTool(cwd: string): AgentTool<typeof writeSchema, WriteToolDetails> {
	return {
		name: "write",
		label: "write",
		description:
			"Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.",
		parameters: writeSchema,
		async execute(_toolCallId, { path: inputPath, content }, signal) {
			const absolutePath = await resolveCwdPath(cwd, inputPath, signal);
			if (signal?.aborted) {
				throw new Error("Aborted");
			}
			let previous: string | undefined;
			try { previous = await readFile(absolutePath, { encoding: "utf8", signal }); }
			catch (error) { if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error; }

			try {
				await mkdir(path.dirname(absolutePath), { recursive: true });
				if (signal?.aborted) {
					throw new Error("Aborted");
				}
				await writeFile(absolutePath, content, { encoding: "utf8", signal });
			} catch (error) {
				if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) {
					throw new Error("Aborted");
				}
				throw error;
			}

			const bytes = Buffer.byteLength(content, "utf8");
			return {
				content: [{ type: "text", text: `Successfully wrote ${bytes} bytes to ${inputPath}` }],
				details: { path: absolutePath, bytes, created: previous === undefined,
					lineCount: content.split(/\r?\n/).length, previewLines: content.split(/\r?\n/).slice(0, 20),
					...(previous === undefined ? {} : buildDiff(absolutePath, previous, content)) },
			};
		},
	};
}
