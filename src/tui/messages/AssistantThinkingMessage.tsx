import { Box } from "ink";
import { ThemedText } from "../theme/ThemeProvider.tsx";
import { CtrlOToExpand } from "./CtrlOToExpand.tsx";
import { wrapText } from "../utils/text.ts";
import { useLocale } from "../locale/LocaleProvider.tsx";
export function AssistantThinkingMessage({ text, expanded, durationMs, maxLines, columns = 80, pending = false }: { text: string; expanded: boolean; durationMs?: number; maxLines?: number; columns?: number; pending?: boolean }) {
	const { t } = useLocale();
	const lines = expanded && text.trim() ? wrapText(text, columns) : [];
	return <Box flexDirection="column" width={columns}>
		<ThemedText color="muted" wrap="truncate-end">{pending ? t("思考中") : durationMs === undefined ? t("思考过程") : `${t("思考耗时")} ${(durationMs / 1000).toFixed(1)}s`}{!expanded && text.trim() ? <> <CtrlOToExpand /></> : null}</ThemedText>
		{lines.length ? <ThemedText color="muted">{(maxLines ? lines.slice(-maxLines) : lines).join("\n")}</ThemedText> : null}
	</Box>;
}
