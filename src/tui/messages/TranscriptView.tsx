import { ThemedText } from "../theme/ThemeProvider.tsx";
import { MessageFrame, frameContentColumns } from "./MessageFrame.tsx";
import type { TranscriptItem } from "../transcript.ts";
import { UserPromptMessage } from "./UserPromptMessage.tsx";
import { AssistantTextMessage } from "./AssistantTextMessage.tsx";
import { AssistantThinkingMessage } from "./AssistantThinkingMessage.tsx";
import { SystemNoticeMessage } from "./SystemNoticeMessage.tsx";
import { CompactBoundaryMessage } from "./CompactBoundaryMessage.tsx";
import { ReadToolView } from "../tools/ReadToolView.tsx";
import { EditToolView } from "../tools/EditToolView.tsx";
import { WriteToolView } from "../tools/WriteToolView.tsx";
import { BashToolView } from "../tools/BashToolView.tsx";
import { SkillToolView } from "../tools/SkillToolView.tsx";
import { McpToolView } from "../tools/McpToolView.tsx";
import { ToolUseCard } from "../tools/ToolUseCard.tsx";
import { toolDetails, toolText } from "../tools/tool-result.ts";
export type TranscriptGroup = TranscriptItem;
export function TranscriptItemView({ item, expanded, thinkingDisplay, columns, live = false, maxLines }: {
	item: TranscriptGroup; expanded: boolean; thinkingDisplay: boolean; columns: number; live?: boolean; maxLines?: number;
}) {
	if (item.kind === "user") return <UserPromptMessage item={item} expanded={expanded} columns={columns} />;
	if (item.kind === "notice") return <SystemNoticeMessage item={item} columns={columns} />;
	if (item.kind === "compact") return <CompactBoundaryMessage item={item} expanded={expanded} columns={columns} />;
	if (item.kind === "assistant") {
		const width = frameContentColumns(columns);
		return <MessageFrame columns={columns} marker="∇">{item.blocks.filter(block => block.text).map(block => block.kind === "thinking"
			? <AssistantThinkingMessage key={block.index} text={block.text} expanded={expanded || thinkingDisplay} durationMs={item.durationMs} columns={width} maxLines={live ? maxLines ?? 5 : undefined} />
			: <AssistantTextMessage key={block.index} text={block.text} columns={width} maxLines={live ? maxLines ?? 12 : undefined} />)}</MessageFrame>;
	}
	const props = { item, expanded, columns, live };
	if (item.name === "read") return <ReadToolView {...props} />;
	if (item.name === "skill") return <SkillToolView {...props} />;
	if (toolDetails(item).kind === "mcp" || item.name.startsWith("mcp__") || item.name === "mcp_list_resources" || item.name === "mcp_read_resource") return <McpToolView {...props} />;
	if (item.name === "edit") return <EditToolView {...props} />;
	if (item.name === "write") return <WriteToolView {...props} />;
	if (item.name === "bash" || item.name === "powershell") return <BashToolView {...props} />;
	return <ToolUseCard item={item} label={item.name} target={JSON.stringify(item.args)} columns={columns}><ThemedText>{toolText(item)}</ThemedText></ToolUseCard>;
}
