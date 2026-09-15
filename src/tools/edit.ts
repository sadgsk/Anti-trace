import { readFile, writeFile } from "node:fs/promises";
import { type Static, Type } from "typebox";
import type { AgentTool } from "../types.ts";
import { resolveCwdPath } from "./path-utils.ts";

const replaceEditSchema = Type.Object({
	oldText: Type.String({
		description:
			"Exact text for one targeted replacement. It must be unique in the original file and must not overlap with any other edits[].oldText in the same call.",
	}),
	newText: Type.String({ description: "Replacement text for this targeted edit." }),
});

export const editSchema = Type.Object({
	path: Type.String({ description: "Path to the file to edit (relative or absolute)" }),
	edits: Type.Array(replaceEditSchema, {
		description:
			"One or more targeted replacements. Each edit is matched against the original file, not incrementally. Do not include overlapping or nested edits. If two changes touch the same block or nearby lines, merge them into one edit instead.",
	}),
});

export type EditToolInput = Static<typeof editSchema>;

export interface EditToolDetails {
	path: string;
	replacements: number;
}

export function createEditTool(cwd: string): AgentTool<typeof editSchema, EditToolDetails> {
	return {
		name: "edit",
		label: "edit",
		description:
			"Edit a single file using exact text replacement. Every edits[].oldText must match a unique, non-overlapping region of the original file. If two changes affect the same block or nearby lines, merge them into one edit instead of emitting overlapping edits. Do not include large unchanged regions just to connect distant changes.",
		parameters: editSchema,
		async execute(_toolCallId, { path: inputPath, edits }, signal) {
			if (!Array.isArray(edits) || edits.length === 0) {
				throw new Error("Edit tool input is invalid. edits must contain at least one replacement.");
			}

			const absolutePath = await resolveCwdPath(cwd, inputPath, signal);

			let original: string;
			try {
				original = await readFile(absolutePath, { encoding: "utf8", signal });
			} catch (error) {
				if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) {
					throw new Error("Aborted");
				}
				if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
					throw new Error(`File not found: ${inputPath}`);
				}
				throw error;
			}

			if (signal?.aborted) {
				throw new Error("Aborted");
			}

			const matches: { editIndex: number; start: number; length: number; newText: string }[] = [];
			for (let i = 0; i < edits.length; i++) {
				const oldText = edits[i].oldText;
				if (oldText.length === 0) {
					throw new Error(`edits[${i}].oldText is empty. Provide the exact text to replace.`);
				}
				const occurrences = original.split(oldText).length - 1;
				if (occurrences === 0) {
					throw new Error(
						edits.length === 1
							? `Could not find the exact text in ${inputPath}. The old text must match exactly including all whitespace and newlines.`
							: `Could not find edits[${i}] in ${inputPath}. The oldText must match exactly including all whitespace and newlines.`,
					);
				}
				if (occurrences > 1) {
					throw new Error(
						edits.length === 1
							? `Found ${occurrences} occurrences of the text in ${inputPath}. The text must be unique. Please provide more context to make it unique.`
							: `Found ${occurrences} occurrences of edits[${i}] in ${inputPath}. Each oldText must be unique. Please provide more context to make it unique.`,
					);
				}
				matches.push({
					editIndex: i,
					start: original.indexOf(oldText),
					length: oldText.length,
					newText: edits[i].newText,
				});
			}

			matches.sort((a, b) => a.start - b.start);
			for (let i = 1; i < matches.length; i++) {
				const previous = matches[i - 1];
				const current = matches[i];
				if (previous.start + previous.length > current.start) {
					throw new Error(
						`edits[${previous.editIndex}] and edits[${current.editIndex}] overlap in ${inputPath}. Merge them into one edit or target disjoint regions.`,
					);
				}
			}

			let next = original;
			for (let i = matches.length - 1; i >= 0; i--) {
				const match = matches[i];
				next = next.slice(0, match.start) + match.newText + next.slice(match.start + match.length);
			}

			if (next === original) {
				throw new Error(`No changes made to ${inputPath}. Each newText must differ from its oldText.`);
			}

			try {
				await writeFile(absolutePath, next, { encoding: "utf8", signal });
			} catch (error) {
				if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) {
					throw new Error("Aborted");
				}
				throw error;
			}

			return {
				content: [{ type: "text", text: `Successfully replaced ${edits.length} block(s) in ${inputPath}.` }],
				details: { path: absolutePath, replacements: edits.length },
			};
		},
	};
}
