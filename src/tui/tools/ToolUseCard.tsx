import type { ReactNode } from "react";
import { Text } from "ink";
import type { ToolUseItem } from "../transcript.ts";
import { StatusIcon } from "../design-system/StatusIcon.tsx";
import { ThemedText } from "../theme/ThemeProvider.tsx";
import { truncateText } from "../utils/text.ts";
import { ToolUseLoader } from "./ToolUseLoader.tsx";
import { MessageFrame, frameContentColumns } from "../messages/MessageFrame.tsx";
export function ToolUseCard({ item, label, target, columns, children }: { item: ToolUseItem; label: string; target: string; columns: number; children: ReactNode }) {
	const elapsed = item.endedAt ? ` · ${((item.endedAt - item.startedAt) / 1000).toFixed(1)}s` : "";
	return <MessageFrame kind="tool" columns={columns}>
		<Text wrap="truncate-end">{item.status === "running" ? <ToolUseLoader /> : <StatusIcon status={item.status} />}
			<Text bold>{label} </Text><ThemedText color="muted">{truncateText(target, Math.max(1, frameContentColumns(columns) - label.length - elapsed.length - 4))}</ThemedText><ThemedText color="dim">{elapsed}</ThemedText></Text>
		{children}
	</MessageFrame>;
}
