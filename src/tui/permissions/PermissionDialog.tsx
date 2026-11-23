import { Box, Text } from "ink";
import type { PermissionSnapshot, PermissionPolicy } from "../../cli/permissions/permission-policy.ts";
import { isShellTool } from "../../cli/permissions/permission-policy.ts";
import { BaseTextInput } from "../../cli/input/base-text-input.tsx";
import { StructuredDiff } from "../diff/StructuredDiff.tsx";
import { Pane } from "../design-system/Pane.tsx";
import { ListItem } from "../design-system/ListItem.tsx";
import { ThemedText } from "../theme/ThemeProvider.tsx";
import { truncateText } from "../utils/text.ts";
import { useLocale } from "../locale/LocaleProvider.tsx";
export function PermissionDialog({ state, policy, columns, availableRows }: { state: PermissionSnapshot; policy: PermissionPolicy; columns: number; availableRows: number }) {
	const request = state.request;
	const { t } = useLocale();
	if (!request) return null;
	const framed = columns >= 40 && availableRows >= 10;
	const width = Math.max(1, columns - (framed ? 4 : 0));
	const sessionLabel = request.permission ? "2. 本会话允许此操作" : isShellTool(request.name) ? "2. 本会话允许这条命令"
		: request.name === "skill" ? "2. 本会话允许此技能" : "2. 本会话允许所有文件编辑";
	const labels = ["1. 允许本次执行", sessionLabel, "3. 拒绝，并输入修改建议"];
	const source = request.agentSource;
	const showAllChoices = availableRows >= (source ? 7 : 6);
	const previewRows = Math.max(0, availableRows - (framed ? 9 : 7) - Number(state.editingFeedback) * 2 - Number(Boolean(source)));
	const content = <Box flexDirection="column">
		<ThemedText color="accent" bold wrap="truncate-end">{request.previewChanged ? t("文件已更改，请重新确认") : `Allow ${request.permission?.label ?? request.name}?`}</ThemedText>
		{source ? <ThemedText color="muted" wrap="truncate-end">{truncateText(`Agent ${source.agent_id} · ${source.summary}`, width)}</ThemedText> : null}
		<ThemedText color="muted" wrap="truncate-end">{truncateText(request.permission ? JSON.stringify(request.args) : String(request.args.path ?? request.args.command ?? JSON.stringify(request.args)), width)}</ThemedText>
		{previewRows > 0 && request.hunks?.length ? <StructuredDiff hunks={request.hunks} columns={width} maxLines={previewRows} /> : null}
		{previewRows > 0 && request.previewError ? <ThemedText color="warning" wrap="truncate-end">{truncateText(t(`预览不可用：${request.previewError}`), width)}</ThemedText> : null}
		{(showAllChoices ? labels : [labels[state.selectedIndex]!]).map((label, index) => <ListItem key={label} selected={!showAllChoices || index === state.selectedIndex} width={width}>{truncateText(t(label), width - 2)}</ListItem>)}
		{state.editingFeedback ? <Box flexDirection="column"><ThemedText color="muted">{t("告诉 Anti-trace 如何修改：")}</ThemedText><BaseTextInput controller={policy.feedback} maxRows={1} /></Box> : null}
		<ThemedText color="dim" wrap="truncate-end">{truncateText(t(state.editingFeedback ? "Enter 拒绝并发送建议 · Esc 返回" : "Enter 确认 · Esc 拒绝 · Shift+Tab 切换模式"), width)}</ThemedText>
	</Box>;
	return <Box flexDirection="column" height={Math.max(1, availableRows)} overflow="hidden">{framed ? <Pane width={columns}>{content}</Pane> : content}</Box>;
}
