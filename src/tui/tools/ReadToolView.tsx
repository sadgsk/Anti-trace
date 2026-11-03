import { Text } from "ink";
import { extname } from "node:path";
import type { ToolUseItem } from "../transcript.ts";
import { ToolUseCard } from "./ToolUseCard.tsx";
import { MessageResponse } from "../messages/MessageResponse.tsx";
import { HighlightedCode } from "../markdown/HighlightedCode.tsx";
import { CtrlOToExpand } from "../messages/CtrlOToExpand.tsx";
import { toolText, toolDetails } from "./tool-result.ts";
export function ReadToolView({ item, expanded, columns, live = false }: { item: ToolUseItem; expanded: boolean; columns: number; live?: boolean }) {
	const details = toolDetails(item), image = item.result?.content.some(block => block.type === "image");
	const count = details.endLine !== undefined ? Math.max(0, Number(details.endLine) - Number(details.startLine) + 1) : toolText(item).split("\n").length;
	return <ToolUseCard item={item} label="Read" target={String(item.args.path ?? details.path ?? "")} columns={columns}>
		{item.result ? <MessageResponse columns={Math.max(1, columns - 4)}>{item.status === "error" ? <Text>{toolText(item)}</Text> : <>
			<Text>{image ? "Read image" : `Read ${count} lines`}{details.truncated ? " · truncated" : ""} <CtrlOToExpand expanded={expanded} /></Text>
			{expanded && !image ? <HighlightedCode code={toolText(item).replace(/^\s*\d+\|/gm, "")} startLine={Number(details.startLine ?? 1)}
				language={extname(String(item.args.path ?? "")).slice(1)} columns={Math.max(1, columns - 8)} maxLines={live ? 8 : undefined} /> : null}
		</>}</MessageResponse> : null}
	</ToolUseCard>;
}
