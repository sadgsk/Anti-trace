import { Box } from "ink";
import type { CompactItem } from "../transcript.ts";
import { Divider } from "../design-system/Divider.tsx";
import { ThemedText } from "../theme/ThemeProvider.tsx";
import { formatTokens } from "../utils/text.ts";
import { Markdown } from "../markdown/Markdown.tsx";
import { CtrlOToExpand } from "./CtrlOToExpand.tsx";
import { useLocale } from "../locale/LocaleProvider.tsx";
export function CompactBoundaryMessage({ item, expanded, columns }: { item: CompactItem; expanded: boolean; columns: number }) {
	const { t } = useLocale();
	return <Box flexDirection="column" marginY={1}><Divider width={columns} color="faint" />
		<ThemedText color="muted">✻ {t("会话已压缩")} · {formatTokens(item.before)} → {formatTokens(item.after)} tokens <CtrlOToExpand expanded={expanded} /></ThemedText>
		{expanded ? <Markdown text={item.summary} columns={columns} /> : null}
	</Box>;
}
