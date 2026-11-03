import { Box, Text } from "ink";
import type { NoticeItem } from "../transcript.ts";
import { ThemedText } from "../theme/ThemeProvider.tsx";
import { StatusIcon } from "../design-system/StatusIcon.tsx";
import { displayText } from "../utils/text.ts";
import { useLocale } from "../locale/LocaleProvider.tsx";
export function SystemNoticeMessage({ item, columns }: { item: NoticeItem; columns: number }) {
	const { t } = useLocale();
	return <Box marginTop={1} width={Math.max(1, columns)}><StatusIcon status={item.tone} /><Box flexDirection="column" width={Math.max(1, columns - 2)}>
		{item.tone === "error" ? <ThemedText color="error">{displayText(t(item.text))}</ThemedText> : <Text>{displayText(t(item.text))}</Text>}
		{item.tone === "error" && /模型|配置|凭据|BYOK|401|403|API|HTTP/i.test(item.text) ? <ThemedText color="dim">{t("/config 查看配置 · /reload 重载 · /model 切换模型")}</ThemedText> : null}
	</Box></Box>;
}
