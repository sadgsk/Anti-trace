import { Box } from "ink";
import { useSyncExternalStore } from "react";
import type { PromptInputController } from "../../cli/input/prompt-input-controller.ts";
import type { PermissionMode } from "../../cli/permissions/permission-policy.ts";
import { BaseTextInput } from "../../cli/input/base-text-input.tsx";
import { ThemedText } from "../theme/ThemeProvider.tsx";
import { truncateText } from "../utils/text.ts";
import { useLocale } from "../locale/LocaleProvider.tsx";
import { railInset } from "../messages/MessageFrame.tsx";

export const inputInset = (columns: number) => Math.min(Math.max(0, columns - 2), railInset(columns) + 2);

export function PromptInputBox({ controller, columns, maxRows, focus, axis, rules, mode, model }: { controller: PromptInputController; columns: number; maxRows: number; focus: boolean; axis: number; rules: boolean; mode?: PermissionMode; model: string }) {
	const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
	const { t } = useLocale();
	const width = columns - axis, prefix = Math.max(0, inputInset(columns) - axis);
	return <Box flexDirection="column" flexShrink={0} width={width} marginLeft={axis} overflow="hidden">
		{rules && <ThemedText>{"─".repeat(width)}</ThemedText>}
		{state.draft.references.length > 0 && <Box marginLeft={prefix}><ThemedText wrap="truncate-end">{truncateText(state.draft.references.map(ref => ref.label).join(" "), width - prefix)}</ThemedText></Box>}
		<Box>
			{prefix > 0 && <Box width={prefix} flexShrink={0}><ThemedText>{">"}</ThemedText></Box>}
			<BaseTextInput controller={controller.textInput} focus={focus} maxRows={maxRows} solidBlankCursor />
		</Box>
		{state.isPasting && <Box marginLeft={prefix}><ThemedText>{t("正在粘贴…")}</ThemedText></Box>}
		{rules && <ThemedText>{"─".repeat(width)}</ThemedText>}
		{mode && <Box height={1} justifyContent="space-between">
			<ThemedText>{truncateText(mode, width)}</ThemedText>
			{model && width > mode.length + 1 && <ThemedText>{truncateText(model, width - mode.length - 1)}</ThemedText>}
		</Box>}
	</Box>;
}
