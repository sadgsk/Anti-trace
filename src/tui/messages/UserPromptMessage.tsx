import { ThemedText } from "../theme/ThemeProvider.tsx";
import type { UserTurnItem } from "../transcript.ts";
import { displayText } from "../utils/text.ts";
import { useLocale } from "../locale/LocaleProvider.tsx";
import { MessageFrame } from "./MessageFrame.tsx";
export function UserPromptMessage({ item, expanded, columns }: { item: UserTurnItem; expanded: boolean; columns: number }) {
	const lines = displayText(item.text).split("\n"), { t } = useLocale();
	const visible = !expanded && lines.length > 12 ? [...lines.slice(0, 6), `… +${lines.length - 9} lines · Ctrl+O ${t("展开")}`, ...lines.slice(-3)] : lines;
	return <MessageFrame columns={columns}>
		<ThemedText bold>{visible.join("\n")}</ThemedText>
		{item.attachments.length ? <ThemedText color="muted">{item.attachments.join(" ")}</ThemedText> : null}
	</MessageFrame>;
}
