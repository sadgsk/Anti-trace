import { Box, Text } from "ink";
import type { UserTurnItem } from "../transcript.ts";
import { ThemedText } from "../theme/ThemeProvider.tsx";
import { displayText } from "../utils/text.ts";
import { useLocale } from "../locale/LocaleProvider.tsx";
export function UserPromptMessage({ item, expanded, columns }: { item: UserTurnItem; expanded: boolean; columns: number }) {
	const lines = displayText(item.text).split("\n");
	const { t } = useLocale();
	const visible = !expanded && lines.length > 12 ? [...lines.slice(0, 6), `… +${lines.length - 9} lines · Ctrl+O ${t("展开")}`, ...lines.slice(-3)].join("\n") : lines.join("\n");
	return <Box flexDirection="column" marginTop={1} width={Math.max(1, columns)}>
		<Box><ThemedText color="accent" bold>❯ </ThemedText><Box width={Math.max(1, columns - 2)}><Text>{visible}</Text></Box></Box>
		{item.attachments.length ? <ThemedText color="accent">{item.attachments.join(" ")}</ThemedText> : null}
	</Box>;
}
