import { Text } from "ink";
import type { ToolUseItem } from "../transcript.ts";
import { ToolUseCard } from "./ToolUseCard.tsx";
import { MessageResponse } from "../messages/MessageResponse.tsx";
import { ThemedText } from "../theme/ThemeProvider.tsx";
import { toolDetails, toolText } from "./tool-result.ts";
import { CtrlOToExpand } from "../messages/CtrlOToExpand.tsx";
import { truncateText } from "../utils/text.ts";
export function BashProgressView({ item, columns }: { item: ToolUseItem; columns: number }) {
	const details = toolDetails(item), lines = details.liveLines as string[] | undefined;
	return lines?.length ? <MessageResponse columns={Math.max(1, columns - 4)}><ThemedText color="muted">{lines.slice(-5).map(line => truncateText(line, columns - 8)).join("\n")}</ThemedText></MessageResponse> : null;
}
export function BashToolView({ item, expanded, columns, live = false }: { item: ToolUseItem; expanded: boolean; columns: number; live?: boolean }) {
	const details = toolDetails(item), text = toolText(item), lines = text.split("\n");
	return <ToolUseCard item={item} label="Bash" target={String(item.args.command ?? "")} columns={columns}>
		{item.status === "running" ? <BashProgressView item={item} columns={columns} /> : <MessageResponse columns={Math.max(1, columns - 4)}>
			{details.exitCode !== undefined && details.exitCode !== 0 ? <ThemedText color="error">exit {String(details.exitCode)}{details.timedOut ? " · timed out" : ""}</ThemedText> : null}
			<Text color={item.status === "error" ? "red" : undefined}>{(expanded && !live ? lines : lines.slice(0, live ? 3 : 5)).join("\n") || "(No content)"}</Text>
			{!expanded && lines.length > 5 ? <ThemedText color="dim">… +{lines.length - 5} lines <CtrlOToExpand /></ThemedText> : null}
		</MessageResponse>}
	</ToolUseCard>;
}
