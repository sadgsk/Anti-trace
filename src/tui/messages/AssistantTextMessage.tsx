import { Markdown } from "../markdown/Markdown.tsx";
import { ThemedText } from "../theme/ThemeProvider.tsx";
import { wrapText } from "../utils/text.ts";
import { MessageFrame, frameContentColumns } from "./MessageFrame.tsx";
import { useLocale } from "../locale/LocaleProvider.tsx";
export function AssistantTextMessage({ text, columns, maxLines }: { text: string; columns: number; maxLines?: number }) {
	const width = frameContentColumns(columns);
	const { t } = useLocale();
	const source = maxLines ? wrapText(text, width).slice(-maxLines).join("\n") : text;
	return text ? <MessageFrame kind="reply" columns={columns}><ThemedText color="brand" bold>{t("回复")}</ThemedText><Markdown text={source} columns={width} /></MessageFrame> : null;
}
