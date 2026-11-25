import { Markdown } from "../markdown/Markdown.tsx";
import { wrapText } from "../utils/text.ts";
export function AssistantTextMessage({ text, columns, maxLines }: { text: string; columns: number; maxLines?: number }) {
	const source = maxLines ? wrapText(text, columns).slice(-maxLines).join("\n") : text;
	return text ? <Markdown text={source} columns={columns} /> : null;
}
