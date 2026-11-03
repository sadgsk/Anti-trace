import type { ToolUseItem } from "../transcript.ts";
import { displayText } from "../utils/text.ts";
export function toolText(item: ToolUseItem): string {
	return displayText(item.result?.content.filter(block => block.type === "text").map(block => block.text).join("\n") ?? "");
}
export function toolDetails(item: ToolUseItem): Record<string, unknown> {
	const details = (item.result ?? item.partial)?.details;
	return details && typeof details === "object" ? details as Record<string, unknown> : {};
}
