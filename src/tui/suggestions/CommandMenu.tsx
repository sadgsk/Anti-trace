import { Box, Text } from "ink";
import { useTheme } from "../theme/ThemeProvider.tsx";
import { layoutCommandMenu, layoutCommandMenuFooter, layoutCommandMenuRow, truncateMenuText } from "./command-menu-layout.ts";
import type { PromptSuggestionsSnapshot } from "./prompt-suggestions-controller.ts";
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
		marginTop={framed ? 1 : 0} paddingX={framed ? 1 : 0}
		borderStyle={framed ? "round" : undefined} borderColor={theme.faint}
		backgroundColor={framed ? theme.bgBar || undefined : undefined} aria-role="menu" aria-label={state.kind === "file" ? "文件补全" : "命令菜单"}>
		{state.items.length === 0 ? <Text color={theme.muted} wrap="truncate-end">
			{truncateMenuText(t(state.loading ? "正在查找文件…" : state.kind === "file" ? "无匹配文件" : "无匹配命令"), contentWidth)}
		</Text> : state.items.slice(start, start + count).map((command, index) => {
			const selected = start + index === state.selectedIndex;
			const pointer = selected ? "❯" : " ";
			const prefix = framed ? `${selected ? "│" : " "}${pointer} ` : contentWidth >= 2 ? `${pointer} ` : pointer;
			const suffix = framed ? selected ? " │" : "  " : "";
			const row = layoutCommandMenuRow({ ...command, description: t(command.description) }, Math.max(0, contentWidth - (framed ? 5 : Math.min(2, contentWidth))), state.kind === "file" ? "@" : "/");
			return <Box key={command.name} flexShrink={0} height={1} width={contentWidth}
				backgroundColor={selected && framed ? theme.selectionBackground : undefined}
				aria-role="menuitem" aria-state={{ selected }}>
				<Text wrap="truncate-end">
					<Text color={theme.accent}>{prefix}{row.name}</Text>
					{row.gap}<Text color={selected ? undefined : theme.muted}>{row.description}</Text>
					<Text color={theme.accent}>{suffix}</Text>
				</Text>
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
