import type { ImageContent } from "../../types.ts";
import type { PastedImage } from "../utils/image-paste.ts";
import { createTextInputState, type TextInputState } from "./text-input-state.ts";

export type PastedContent =
	| { readonly id: number; readonly type: "text"; readonly text: string }
	| { readonly id: number; readonly type: "image"; readonly image: Readonly<ImageContent>; readonly filename?: string; readonly sourcePath?: string };

/** Only ranges created by the editor are references; matching user text stays literal. */
export interface PromptReference {
	readonly id: number;
	readonly start: number;
	readonly end: number;
	readonly label: string;
}

export interface PromptDraft extends TextInputState {
	readonly pastedContents: Readonly<Record<number, PastedContent>>;
	readonly references: readonly PromptReference[];
}

export interface PromptSubmission {
	text: string;
	images: ImageContent[];
}

export function createPromptDraft(text = "", cursor = text.length): PromptDraft {
	return snapshotPromptDraft({ ...createTextInputState(text, cursor), pastedContents: {}, references: [] });
}

/** Copy and freeze the whole draft, including attachments and trusted reference positions. */
export function snapshotPromptDraft(draft: PromptDraft): PromptDraft {
	const state = createTextInputState(draft.text, draft.cursor);
	const references: PromptReference[] = [];
	const pastedContents: Record<number, PastedContent> = {};
	for (const ref of [...draft.references].sort((left, right) => left.start - right.start)) {
		const content = draft.pastedContents[ref.id];
		if (!content || content.id !== ref.id || !Number.isSafeInteger(ref.id) || ref.id < 1
			|| !Number.isInteger(ref.start) || !Number.isInteger(ref.end)
			|| ref.start < (references.at(-1)?.end ?? 0) || ref.end <= ref.start || ref.end > state.text.length
			|| state.text.slice(ref.start, ref.end) !== ref.label) continue;
		references.push(Object.freeze({ ...ref }));
		pastedContents[ref.id] = content.type === "text"
			? Object.freeze({ ...content })
			: Object.freeze({ ...content, image: Object.freeze({ ...content.image }) });
	}
	return Object.freeze({ ...state, pastedContents: Object.freeze(pastedContents), references: Object.freeze(references) });
}

export function imagePastedContent(id: number, pasted: PastedImage): PastedContent {
	return { id, type: "image", image: { ...pasted.image }, filename: pasted.filename, sourcePath: pasted.sourcePath };
}

/** Submission boundary: expand trusted text once and collect only live images in input order. */
export function preparePromptSubmission(draft: PromptDraft): PromptSubmission {
	const current = snapshotPromptDraft(draft);
	const parts: string[] = [];
	const images: ImageContent[] = [];
	let offset = 0;
	for (const ref of current.references) {
		parts.push(current.text.slice(offset, ref.start));
		const content = current.pastedContents[ref.id]!;
		if (content.type === "text") parts.push(content.text);
		else images.push({ ...content.image });
		offset = ref.end;
	}
	parts.push(current.text.slice(offset));
	return { text: parts.join(""), images };
}
