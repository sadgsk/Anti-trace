import { Box, Text } from "ink";
import { useTheme } from "../theme/ThemeProvider.tsx";
import { layoutCommandMenu, layoutCommandMenuFooter, layoutCommandMenuRow, truncateMenuText } from "./command-menu-layout.ts";
import type { PromptSuggestionsSnapshot } from "./prompt-suggestions-controller.ts";
import { cutBorder, PanelTitle } from "../design-system/Pane.tsx";
import { ListItem } from "../design-system/ListItem.tsx";
import { useLocale } from "../locale/LocaleProvider.tsx";

export interface CommandMenuProps {
	state: PromptSuggestionsSnapshot;
	availableColumns: number;
	/** Total height, including the panel's borders and footer. */
	availableRows: number;
}

/** P09's terminal view: state and viewport in, Ink nodes out. No input or command execution. */
export function CommandMenu({ state, availableColumns, availableRows }: CommandMenuProps) {
	const theme = useTheme();
	const { t } = useLocale();
	const layout = layoutCommandMenu(state, availableColumns, availableRows);
	if (!layout) return null;
	const { width, marginLeft, framed, contentWidth, start, count } = layout;
	const footer = layoutCommandMenuFooter(contentWidth, state.selectedIndex, state.items.length, state.kind === "file", t);
	return <Box flexDirection="column" flexShrink={0} width={width} marginLeft={marginLeft}
		paddingX={framed ? 1 : 0}
		borderStyle={framed ? cutBorder : undefined} borderColor={theme.faint || undefined}
		aria-role="menu" aria-label={state.kind === "file" ? "文件补全" : "命令菜单"}>
		{framed && <PanelTitle title={t(state.kind === "file" ? "文件补全" : "命令")} width={contentWidth} />}
		{state.items.length === 0 ? <Text color={theme.muted} wrap="truncate-end">
			{truncateMenuText(t(state.loading ? "正在查找文件…" : state.kind === "file" ? "无匹配文件" : "无匹配命令"), contentWidth)}
		</Text> : state.items.slice(start, start + count).map((command, index) => {
			const selected = start + index === state.selectedIndex;
			const row = layoutCommandMenuRow({ ...command, description: t(command.description) }, Math.max(0, contentWidth - 2), state.kind === "file" ? "@" : "/");
			return <Box key={command.name} aria-role="menuitem" aria-state={{ selected }}>
				<ListItem selected={selected} width={contentWidth}>{row.name + row.gap + row.description}</ListItem>
			</Box>;
		})}
		{layout.more ? <Text color={theme.dim} wrap="truncate-end">{truncateMenuText(t(layout.more), contentWidth)}</Text> : null}
		{framed ? <Text color={theme.faint}>{"─".repeat(contentWidth)}</Text> : null}
		{layout.footer ? <Text color={theme.dim} wrap="truncate-end">
			{footer.shortcuts.map((item, index) => <Text key={item.shortcut}>
				{index > 0 ? "  " : ""}<Text color={theme.accent} bold>{item.shortcut}</Text> {item.action}
			</Text>)}{footer.gap}<Text color={theme.muted}>{footer.counter}</Text>
		</Text> : null}
	</Box>;
}
