import { Box, Text } from "ink";
import type { ToolUseItem } from "../transcript.ts";
import { StatusIcon } from "../design-system/StatusIcon.tsx";
import { ThemedText } from "../theme/ThemeProvider.tsx";
import { ReadToolView } from "./ReadToolView.tsx";
import { toolDetails } from "./tool-result.ts";
import { CtrlOToExpand } from "../messages/CtrlOToExpand.tsx";
import { truncateText } from "../utils/text.ts";
import { MessageFrame, frameContentColumns } from "../messages/MessageFrame.tsx";
export function GroupedToolUseView({ items, expanded, columns, live }: { items: readonly ToolUseItem[]; expanded: boolean; columns: number; live?: boolean }) {
	if (expanded) return <Box flexDirection="column">{items.map(item => <ReadToolView key={item.id} item={item} expanded columns={columns} live={live} />)}</Box>;
	const total = items.reduce((sum, item) => { const detail = toolDetails(item); return sum + Math.max(0, Number(detail.endLine ?? 0) - Number(detail.startLine ?? 1) + 1); }, 0);
	return <MessageFrame kind="tool" columns={columns}><Text wrap="truncate-end"><StatusIcon status="success" />Read {items.length} files <ThemedText color="dim">· {total} lines </ThemedText><CtrlOToExpand /></Text>
		{items.slice(0, 3).map(item => <ThemedText key={item.id} color="muted">{truncateText(`  ⎿ ${String(item.args.path)}`, frameContentColumns(columns))}</ThemedText>)}
		{items.length > 3 ? <ThemedText color="dim">  ⎿ … +{items.length - 3} more files</ThemedText> : null}
	</MessageFrame>;
}
