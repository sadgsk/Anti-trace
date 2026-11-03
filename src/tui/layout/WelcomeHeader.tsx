import { homedir } from "node:os";
import stringWidth from "string-width";
import { Box, Text } from "ink";
import type { HarnessDisplayState } from "../../harness/harness.ts";
import type { PermissionMode } from "../permissions/permission-policy.ts";
import { BrandMark } from "./BrandMark.tsx";
import { ThemedText } from "../theme/ThemeProvider.tsx";
import { formatTokens, truncateText } from "../utils/text.ts";
import { useLocale } from "../locale/LocaleProvider.tsx";
export function WelcomeHeader({ cwd, display, columns }: { cwd: string; display: HarnessDisplayState; columns: number; rows: number; permissionMode: PermissionMode }) {
	const { t } = useLocale(), path = cwd.startsWith(homedir()) ? `~${cwd.slice(homedir().length)}` : cwd;
	const suffix = ` · ${formatTokens(display.contextUsed)} / ${display.contextWindow ? formatTokens(display.contextWindow) : t("未配置")} · ${display.thinking.effort}`;
	const right = Math.min(columns, stringWidth(display.modelName + suffix)), left = Math.max(0, columns - right - 2);
	const together = left >= 8, cyan = together ? right : Math.min(columns, Math.max(16, Math.floor(columns / 3)));
	const model = <Text wrap="truncate-end"><ThemedText color="brand">{truncateText(display.modelName === "模型未配置" ? t(display.modelName) : display.modelName, Math.max(1, right - stringWidth(suffix)))}</ThemedText><ThemedText color="muted">{suffix}</ThemedText></Text>;
	return <Box flexDirection="column" marginBottom={1} width={columns} flexShrink={0} overflow="hidden">
		<BrandMark columns={columns} />
		<Text wrap="truncate-end"><ThemedText color="brand">{"─".repeat(Math.max(0, columns - cyan - 1))}</ThemedText> <ThemedText color="accent">{"─".repeat(cyan)}</ThemedText></Text>
		{together ? <Box justifyContent="space-between"><ThemedText color="muted" wrap="truncate-end">{truncateText(path, left)}</ThemedText><Box width={right} flexShrink={0}>{model}</Box></Box>
			: <><ThemedText color="muted" wrap="truncate-end">{truncateText(path, columns)}</ThemedText><Box justifyContent="flex-end">{model}</Box></>}
	</Box>;
}
