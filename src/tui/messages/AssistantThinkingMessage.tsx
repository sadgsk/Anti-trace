import { Box } from "ink";
import { ThemedText } from "../theme/ThemeProvider.tsx";
import { CtrlOToExpand } from "./CtrlOToExpand.tsx";
import { wrapText } from "../utils/text.ts";
import { useLocale } from "../locale/LocaleProvider.tsx";
export function AssistantThinkingMessage({ text, expanded, durationMs, maxLines, columns = 80 }: { text: string; expanded: boolean; durationMs?: number; maxLines?: number; columns?: number }) {
	const { t } = useLocale();
	if (!text) return null;
	const width = Math.max(1, columns - 2), lines = wrapText(text, width);
	return <Box flexDirection="column" flexShrink={0} width={columns}><ThemedText color="dim" italic wrap="truncate-end">∴ {durationMs ? `${t("思考耗时")} ${(durationMs / 1000).toFixed(1)}s` : t("思考中")} {!expanded ? <CtrlOToExpand /> : null}</ThemedText>
		{expanded ? <Box flexShrink={0}><Box width={2} flexShrink={0}><ThemedText color="dim">▎ </ThemedText></Box><Box width={width} flexShrink={0}><ThemedText color="muted">{(maxLines ? lines.slice(-maxLines) : lines).join("\n")}</ThemedText></Box></Box> : null}
	</Box>;
}
