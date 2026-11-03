import { Box } from "ink";
import { useSyncExternalStore } from "react";
import { BaseTextInput } from "../../cli/input/base-text-input.tsx";
import { ThemedBox, ThemedText } from "../theme/ThemeProvider.tsx";
import { truncateText } from "../utils/text.ts";
import { useLocale } from "../locale/LocaleProvider.tsx";
import type { CommandDialogController, CommandChoice } from "./command-dialog-controller.ts";

export function CommandDialog({ controller, columns, rows }: { controller: CommandDialogController; columns: number; rows: number }) {
	const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot), { t } = useLocale();
	if (!state) return null;
	const width = Math.max(1, columns - 4), count = Math.max(1, rows - (state.error ? 10 : 8));
	const choices: readonly CommandChoice[] = state.kind === "picker" ? state.choices : state.kind === "field" ? (state.field.options ?? []).map(id => ({ id, label: id, current: id === state.field.value }))
		: [...state.fields.map(field => ({ id: field.key, label: field.label, description: field.secret ? field.value ? "••••••••" : t(field.placeholder ?? "未填写") : field.value ? field.options ? t(field.value) : field.value : t(field.placeholder ?? "未填写"), descriptionLiteral: true })), { id: ":save", label: "保存并使用此配置" }];
	const start = Math.max(0, Math.min(state.selected - Math.floor(count / 2), choices.length - count));
	const horizontal = state.kind === "picker" && state.horizontal && columns >= 54;
	return <ThemedBox flexDirection="column" borderStyle="round" color="accent" width={columns} paddingX={1} flexShrink={0}>
		<ThemedText color="brand" bold wrap="truncate-end">{t(state.title)}</ThemedText>
		{state.description ? <ThemedText color="muted" wrap="truncate-end">{truncateText(t(state.description), width)}</ThemedText> : null}
		<Box flexDirection="column" marginY={1}>
			{state.kind === "field" && !state.field.options ? <BaseTextInput controller={controller.editor} mask={state.field.secret} maxRows={1} />
				: horizontal ? <Box gap={2}>{choices.map((item, i) => <ThemedText key={item.id} color={i === state.selected ? "accent" : "muted"} bold={i === state.selected}>{i === state.selected ? "❯ " : "  "}{item.literal ? item.label : t(item.label)}{item.current ? " ✓" : ""}</ThemedText>)}</Box>
					: choices.slice(start, start + count).map((item, i) => <ThemedText key={item.id} color={start + i === state.selected ? "accent" : undefined} wrap="truncate-end">{start + i === state.selected ? "❯ " : "  "}{truncateText(`${item.literal ? item.label : t(item.label)}${item.current ? " ✓" : ""}${item.description ? ` · ${item.descriptionLiteral ? item.description : t(item.description)}` : ""}`, Math.max(1, width - 2))}</ThemedText>)}
			{!choices.length && state.kind !== "field" ? <ThemedText color="muted">{t("暂无可选项")}</ThemedText> : null}
		</Box>
		{state.error ? <ThemedText color="error">{truncateText(t(state.error), width * 2)}</ThemedText> : null}
		<ThemedText color="muted" wrap="truncate-end">{state.kind === "form" ? t("Enter 编辑 · Ctrl+S 保存 · Esc 返回") : state.kind === "field" && !state.field.options ? t("Enter 确认 · Esc 返回") : `${horizontal ? "←→ / ↑↓" : "↑↓"} ${t("选择")} · Enter ${t("确认")} · Esc ${t("返回")}`}</ThemedText>
		{choices.length > count && !horizontal ? <ThemedText color="dim">{state.selected + 1}/{choices.length}</ThemedText> : null}
	</ThemedBox>;
}
