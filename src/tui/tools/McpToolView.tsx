import { Text } from "ink";
import type { McpResultDetails } from "../../mcp/content.ts";
import { useLocale } from "../locale/LocaleProvider.tsx";
import { MessageResponse } from "../messages/MessageResponse.tsx";
import type { ToolUseItem } from "../transcript.ts";
import { displayText, truncateText } from "../utils/text.ts";
import { ToolUseCard } from "./ToolUseCard.tsx";
import { toolText } from "./tool-result.ts";

function mcpDetails(value: unknown): McpResultDetails | undefined {
	if (!value || typeof value !== "object" || !("kind" in value) || value.kind !== "mcp"
		|| !("version" in value) || value.version !== 1) return undefined;
	return value as McpResultDetails;
}

export function McpToolView({ item, expanded, columns }: { item: ToolUseItem; expanded: boolean; columns: number }) {
	const { t } = useLocale();
	const details = mcpDetails(item.result?.details) ?? mcpDetails(item.partial?.details);
	const progress = item.status === "running" ? details?.progress : undefined;
	const target = displayText(details ? `${details.serverId} · ${details.operation}` : item.name);
	const width = Math.max(1, columns - 6);
	const body = toolText(item);
	const images = item.result?.content.filter(block => block.type === "image") ?? [];
	const args = expanded && JSON.stringify(item.args);
	return <ToolUseCard item={item} label="MCP" target={target} columns={columns}>
		<MessageResponse columns={width}>
			{args ? <Text>{displayText(args)}</Text> : null}
			{progress ? <Text>{truncateText([progress.total === undefined ? String(progress.progress) : `${progress.progress}/${progress.total}`, progress.message].filter(Boolean).join(" · "), width)}</Text> : null}
			{body ? <Text>{expanded ? body : truncateText(body, width)}</Text> : null}
			{images.length ? <Text>{t("图片")} × {images.length}{expanded ? " · " + images.map(i => displayText(i.mimeType)).join(", ") : ""}</Text> : null}
			{details?.errorCode ? <Text>{displayText(details.errorCode)}</Text> : null}
			{details?.truncated ? <Text>{t("结果已截断")}</Text> : null}
			{expanded && Array.isArray(details?.attachments) ? details.attachments.map(a => <Text key={a.path}>{displayText(`${a.path} · ${a.mimeType} · ${a.bytes} B`)}</Text>) : null}
		</MessageResponse>
	</ToolUseCard>;
}
