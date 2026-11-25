import { Box } from "ink";
import { useLayoutEffect } from "react";
import type { PermissionSnapshot, PermissionPolicy } from "../../cli/permissions/permission-policy.ts";
import { isShellTool } from "../../cli/permissions/permission-policy.ts";
import { BaseTextInput } from "../../cli/input/base-text-input.tsx";
import { StructuredDiff } from "../diff/StructuredDiff.tsx";
import { Pane, PanelTitle } from "../design-system/Pane.tsx";
import { ListItem } from "../design-system/ListItem.tsx";
import { ThemedText } from "../theme/ThemeProvider.tsx";
import { truncateText } from "../utils/text.ts";
import { useLocale } from "../locale/LocaleProvider.tsx";
/** Reserve just the rows the approval uses, leaving the latest tool call above the composer. */
export function layoutPermissionDialog(state: PermissionSnapshot, columns: number, screenRows: number) {
	const source = Boolean(state.request?.agentSource), feedback = state.editingFeedback;
	const bodyRows = 6 + Number(source) + (feedback ? 2 : 0);
	const budget = Math.max(1, screenRows - Math.min(3, Math.floor(screenRows / 6)));
	const framed = columns >= 24 && budget >= bodyRows + 2;
	const width = Math.max(1, columns - (framed ? 4 : 0));
	const bodyBudget = budget - (framed ? 2 : 0);
	const allChoices = bodyBudget >= bodyRows;
	const choiceRows = allChoices ? 3 : Number(!feedback || bodyBudget > 1);
	const detailRows = bodyBudget - choiceRows - Number(feedback);
	const title = detailRows >= 1, target = detailRows >= 2;
	const origin = source && detailRows >= 3;
	const feedbackLabel = feedback && detailRows >= 3 + Number(origin);
	const footer = detailRows >= 3 + Number(origin) + Number(feedbackLabel);
	const hunks = state.request?.hunks ?? [];
	const diffRows = hunks.reduce((sum, hunk) => sum + hunk.lines.length + Number(hunks.length > 1), 0);
	const previewBudget = Math.max(0, Math.min(bodyBudget - bodyRows, Math.floor(screenRows / 2)));
	const error = Boolean(state.request?.previewError) && previewBudget > 0;
	const previewRows = Math.min(diffRows, previewBudget - Number(error));
	// StructuredDiff appends a summary row when the preview is truncated.
	const diffLimit = previewRows < diffRows ? Math.max(0, previewRows - 1) : previewRows;
	const height = (framed ? 2 : 0) + choiceRows + Number(feedback) + Number(title) + Number(target) + Number(origin)
		+ Number(feedbackLabel) + Number(footer) + previewRows + Number(error);
	return { columns, width, height, framed, allChoices, choiceRows, title, target, origin, feedbackLabel, footer, error, previewRows, diffLimit };
}

export function PermissionDialog({ state, policy, layout }: { state: PermissionSnapshot; policy: PermissionPolicy; layout: ReturnType<typeof layoutPermissionDialog> }) {
	const request = state.request;
	const { t } = useLocale();
	const { width } = layout;
	useLayoutEffect(() => { policy.feedback.setAvailableColumns(Math.max(1, width - 1)); }, [policy, width]);
	if (!request) return null;
	const sessionLabel = request.permission ? "2. 本会话允许此操作" : isShellTool(request.name) ? "2. 本会话允许这条命令"
		: request.name === "skill" ? "2. 本会话允许此技能" : "2. 本会话允许所有文件编辑";
	const labels = ["1. 允许本次执行", sessionLabel, "3. 拒绝，并输入修改建议"];
	const source = request.agentSource;
	const content = <Box flexDirection="column">
		{layout.title && <PanelTitle title={request.previewChanged ? t("文件已更改，请重新确认") : t("审批") + " · " + (request.permission?.label ?? request.name)} width={width} />}
		{layout.origin && source && <ThemedText color="muted" wrap="truncate-end">{truncateText(`Agent ${source.agent_id} · ${source.summary}`, width)}</ThemedText>}
		{layout.target && <ThemedText color="muted" wrap="truncate-end">{truncateText(request.permission ? JSON.stringify(request.args) : String(request.args.path ?? request.args.command ?? JSON.stringify(request.args)), width)}</ThemedText>}
		{layout.previewRows > 0 && request.hunks && <StructuredDiff hunks={request.hunks} columns={width} maxLines={layout.diffLimit} />}
		{layout.error && <ThemedText color="warning" wrap="truncate-end">{truncateText(t(`预览不可用：${request.previewError}`), width)}</ThemedText>}
		{layout.choiceRows > 0 && (layout.allChoices ? labels : [labels[state.selectedIndex]!]).map((label, index) => <ListItem key={label} selected={!layout.allChoices || index === state.selectedIndex} width={width}>{truncateText(t(label), width - 2)}</ListItem>)}
		{layout.feedbackLabel && <ThemedText color="muted" wrap="truncate-end">{truncateText(t("告诉 ResidualX 如何修改："), width)}</ThemedText>}
		{state.editingFeedback && <BaseTextInput controller={policy.feedback} maxRows={1} />}
		{layout.footer && <ThemedText color="dim" wrap="truncate-end">{truncateText(t(state.editingFeedback ? "Enter 拒绝并发送建议 · Esc 返回" : "Enter 确认 · Esc 拒绝 · Shift+Tab 切换模式"), width)}</ThemedText>}
	</Box>;
	return <Box flexDirection="column" height={layout.height} flexShrink={0} overflow="hidden">{layout.framed ? <Pane width={layout.columns}>{content}</Pane> : content}</Box>;
}
