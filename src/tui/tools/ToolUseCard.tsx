import type { ReactNode } from "react";
import type { ToolUseItem } from "../transcript.ts";
import { ThemedText } from "../theme/ThemeProvider.tsx";
import { useLocale } from "../locale/LocaleProvider.tsx";
import { truncateText } from "../utils/text.ts";
import { MessageFrame, frameContentColumns } from "../messages/MessageFrame.tsx";
import stringWidth from "string-width";

export function ToolUseCard({ item, label, target, columns, children }: { item: ToolUseItem; label: string; target: string; columns: number; children: ReactNode }) {
	const { t } = useLocale();
	const elapsed = item.endedAt === undefined ? "" : ` · ${((item.endedAt - item.startedAt) / 1000).toFixed(1)}s`;
	const state = item.status === "error" ? t("失败") : item.status === "running" ? t("执行中") : "";
	const tag = label === item.name ? label : label.toUpperCase(), suffix = (state ? " · " + state : "") + elapsed;
	const width = frameContentColumns(columns);
	return <MessageFrame columns={columns}>
		<ThemedText wrap="truncate-end"><ThemedText bold>{" " + tag + " "}</ThemedText>{" "}
			{truncateText(target, Math.max(1, width - stringWidth(tag + suffix) - 3))}{suffix}</ThemedText>
		{children}
	</MessageFrame>;
}
