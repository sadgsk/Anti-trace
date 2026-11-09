import { Box, Text } from "ink";
import type { TranscriptItem, ToolUseItem } from "../transcript.ts";
import { UserPromptMessage } from "./UserPromptMessage.tsx";
import { AssistantTextMessage } from "./AssistantTextMessage.tsx";
import { AssistantThinkingMessage } from "./AssistantThinkingMessage.tsx";
import { SystemNoticeMessage } from "./SystemNoticeMessage.tsx";
import { CompactBoundaryMessage } from "./CompactBoundaryMessage.tsx";
import { ReadToolView } from "../tools/ReadToolView.tsx";
import { EditToolView } from "../tools/EditToolView.tsx";
import { WriteToolView } from "../tools/WriteToolView.tsx";
import { BashToolView } from "../tools/BashToolView.tsx";
import { GroupedToolUseView } from "../tools/GroupedToolUseView.tsx";
import { ToolUseCard } from "../tools/ToolUseCard.tsx";
import { toolText } from "../tools/tool-result.ts";
export type TranscriptGroup = TranscriptItem | { id: number; kind: "reads"; items: ToolUseItem[] };
export function groupTranscript(items: readonly TranscriptItem[]): TranscriptGroup[] {
	const result: TranscriptGroup[] = [];
	for (const item of items) {
		if (item.kind === "assistant" && !item.blocks.some(block => block.text)) continue;
		const last = result.at(-1);
		if (item.kind === "tool" && item.name === "read" && item.status === "success") {
			if (last?.kind === "reads") { last.items.push(item); continue; }
			if (last?.kind === "tool" && last.name === "read" && last.status === "success") {
				result[result.length - 1] = { id: last.id, kind: "reads", items: [last, item] }; continue;
			}
		}
		result.push(item);
	}
	return result;
}
export function TranscriptItemView({ item, expanded, thinkingDisplay, columns, live = false, maxLines }: {
	item: TranscriptGroup; expanded: boolean; thinkingDisplay: boolean; columns: number; live?: boolean; maxLines?: number;
}) {
	if (item.kind === "user") return <UserPromptMessage item={item} expanded={expanded} columns={columns} />;
	if (item.kind === "notice") return <SystemNoticeMessage item={item} columns={columns} />;
	if (item.kind === "compact") return <CompactBoundaryMessage item={item} expanded={expanded} columns={columns} />;
	if (item.kind === "reads") return <GroupedToolUseView items={item.items} expanded={expanded} columns={columns} live={live} />;
	if (item.kind === "assistant") return <Box flexDirection="column">{item.blocks.map(block => block.kind === "thinking"
		? <AssistantThinkingMessage key={block.index} text={block.text} expanded={expanded || thinkingDisplay} durationMs={item.durationMs} columns={columns} maxLines={live ? maxLines ?? 5 : undefined} />
		: <AssistantTextMessage key={block.index} text={block.text} columns={columns} maxLines={live ? maxLines ?? 12 : undefined} />)}</Box>;
	const props = { item, expanded, columns, live };
	if (item.name === "read") return <ReadToolView {...props} />;
	if (item.name === "edit") return <EditToolView {...props} />;
	if (item.name === "write") return <WriteToolView {...props} />;
	if (item.name === "bash" || item.name === "powershell") return <BashToolView {...props} />;
	return <ToolUseCard item={item} label={item.name} target={JSON.stringify(item.args)} columns={columns}><Text>{toolText(item)}</Text></ToolUseCard>;
}
