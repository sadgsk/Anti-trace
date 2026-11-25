import type { NoticeItem } from "../transcript.ts";
import { ThemedText } from "../theme/ThemeProvider.tsx";
import { MessageFrame } from "./MessageFrame.tsx";
import { displayText } from "../utils/text.ts";
import { useLocale } from "../locale/LocaleProvider.tsx";
export function SystemNoticeMessage({ item, columns }: { item: NoticeItem; columns: number }) {
	const { t } = useLocale();
	return <MessageFrame columns={columns}>
		<ThemedText color={item.tone === "error" ? "error" : undefined}>{displayText(t(item.text))}</ThemedText>
		{item.tone === "error" && /模型|配置|凭据|BYOK|401|403|API|HTTP/i.test(item.text) ? <ThemedText color="dim">{t("/config 查看配置 · /reload 重载 · /model 切换模型")}</ThemedText> : null}
	</MessageFrame>;
}
