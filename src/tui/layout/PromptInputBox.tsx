import { Box, Text } from "ink";
import { useSyncExternalStore } from "react";
import type { PromptInputController } from "../../cli/input/prompt-input-controller.ts";
import { BaseTextInput } from "../../cli/input/base-text-input.tsx";
import { useTheme, ThemedText } from "../theme/ThemeProvider.tsx";
import type { PermissionMode } from "../../cli/permissions/permission-policy.ts";
import { truncateText } from "../utils/text.ts";
import { useLocale } from "../locale/LocaleProvider.tsx";
export function PromptInputBox({ controller, columns, maxRows, focus, mode, resume }: { controller: PromptInputController; columns: number; maxRows: number; focus: boolean; mode: PermissionMode; resume: boolean }) {
	const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot), colors = useTheme();
	const prefix = "❯ ";
	const { t } = useLocale();
	return <Box flexDirection="column" flexShrink={0}>
		<ThemedText color="muted" wrap="truncate-end">{"─".repeat(columns)}</ThemedText>
		{state.draft.references.length ? <ThemedText color="accent" wrap="truncate-end">{truncateText(state.draft.references.map(ref => ref.label).join(" "), columns)}</ThemedText> : null}
		{resume ? <ThemedText color="muted">{t("输入会话序号，空行取消")}</ThemedText> : null}
		<Box><ThemedText color={mode === "yolo" ? "warning" : "accent"} bold>{prefix}</ThemedText>
			<BaseTextInput controller={controller.textInput} focus={focus} cursorColor={colors.brand || undefined} maxRows={maxRows}
				placeholder={!resume && !state.isPasting && columns >= 40 ? ` ${t("输入 / 查看命令")}` : undefined} />
		</Box>
		{state.isPasting ? <Text dimColor>Processing paste…</Text> : null}
		<ThemedText color="muted" wrap="truncate-end">{"─".repeat(columns)}</ThemedText>
	</Box>;
}
