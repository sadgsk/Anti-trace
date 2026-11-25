import { Box } from "ink";
import { useSyncExternalStore } from "react";
import stringWidth from "string-width";
import { BaseTextInput } from "../../cli/input/base-text-input.tsx";
import { ThemedText } from "../theme/ThemeProvider.tsx";
import { truncateText, wrapText } from "../utils/text.ts";
import { Pane, PanelTitle } from "../design-system/Pane.tsx";
import { ListItem } from "../design-system/ListItem.tsx";
import { useLocale } from "../locale/LocaleProvider.tsx";
import type { CommandDialogController, CommandChoice } from "./command-dialog-controller.ts";

export function CommandDialog({ controller, columns, rows }: { controller: CommandDialogController; columns: number; rows: number }) {
	const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot), { t } = useLocale();
	if (!state) return null;
	const width = Math.max(1, columns - 4);
	const description = state.description ? wrapText(t(state.description), width).slice(0, Math.max(1, rows - 7)) : [];
	const count = Math.max(1, rows - (state.error ? 9 : 7) - description.length);
	if (state.kind === "preview") {
		const visible = Math.max(1, rows - 6);
		const end = Math.min(state.lines.length, state.selected + visible);
		let footer = "Enter " + t(state.acceptLabel);
		const hints: string[] = [];
		if (state.alternateText) hints.push("←→ " + t(state.showingRaw ? "草稿预览" : "原始模板消息"));
		if (state.lines.length > visible) hints.push(`↑↓ ${state.selected + 1}–${end}/${state.lines.length}`);
		if (state.pages > 1) hints.push(`PgUp/PgDn ${state.page + 1}/${state.pages}`);
		hints.push("Esc " + t("返回"));
		for (const hint of hints) {
			const next = footer + "  " + hint;
			if (stringWidth(next) <= width) footer = next;
		}
		return <Pane width={columns} flexShrink={0}>
			<PanelTitle title={t(state.showingRaw ? "原始模板消息" : state.title)} width={width} />
			<ThemedText>{state.lines.slice(state.selected, end).join("\n")}</ThemedText>
			<ThemedText color="dim" wrap="truncate-end">{footer}</ThemedText>
		</Pane>;
	}
	const choices: readonly CommandChoice[] = state.kind === "picker" ? state.choices : state.kind === "input" ? [] : state.kind === "field" ? (state.field.options ?? []).map(id => ({ id, label: id, current: id === state.field.value }))
		: [...state.fields.map(field => ({ id: field.key, label: field.label, description: field.secret ? field.value ? "••••••••" : t(field.placeholder ?? "未填写") : field.value ? field.options ? t(field.value) : field.value : t(field.placeholder ?? "未填写"), descriptionLiteral: true })), { id: ":save", label: state.saveLabel ?? "保存并使用此配置" }];
	const start = Math.max(0, Math.min(state.selected - Math.floor(count / 2), choices.length - count));
	const horizontal = state.kind === "picker" && state.horizontal && columns >= 54;
	return <Pane width={columns} flexShrink={0}>
		<PanelTitle title={t(state.title)} width={width} />
		{description.length ? <ThemedText color="muted">{description.join("\n")}</ThemedText> : null}
		<Box flexDirection="column" marginY={1}>
			{(state.kind === "input" || state.kind === "field") && !state.field.options ? <BaseTextInput controller={controller.editor} mask={state.field.secret} maxRows={1} />
				: horizontal ? <Box gap={2}>{choices.map((item, i) => <ListItem key={item.id} selected={i === state.selected}>{(item.literal ? item.label : t(item.label)) + (item.current && !item.description ? " · " + t("当前使用") : "")}</ListItem>)}</Box>
					: choices.slice(start, start + count).map((item, i) => <ListItem key={item.id} selected={start + i === state.selected} width={width}>{(item.literal ? item.label : t(item.label)) + (item.current && !item.description ? " · " + t("当前使用") : "") + (item.description ? " · " + (item.descriptionLiteral ? item.description : t(item.description)) : "")}</ListItem>)}
			{!choices.length && state.kind !== "field" && state.kind !== "input" ? <ThemedText color="muted">{t("暂无可选项")}</ThemedText> : null}
		</Box>
		{state.error ? <ThemedText color="error">{truncateText(t(state.error), width * 2)}</ThemedText> : null}
		<ThemedText color="muted" wrap="truncate-end">{state.kind === "form" ? t("Enter 编辑 · Ctrl+S 保存 · Esc 返回") : (state.kind === "input" || state.kind === "field") && !state.field.options ? t("Enter 确认 · Esc 返回") : `${horizontal ? "←→ / ↑↓" : "↑↓"} ${t("选择")} · Enter ${t("确认")} · Esc ${t("返回")}`}</ThemedText>
		{choices.length > count && !horizontal ? <ThemedText color="dim">{state.selected + 1}/{choices.length}</ThemedText> : null}
	</Pane>;
}
