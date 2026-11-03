import type { HarnessDisplayState } from "../../harness/harness.ts";
import type { PermissionMode } from "../permissions/permission-policy.ts";
import { ThemedText } from "../theme/ThemeProvider.tsx";
import { truncateText } from "../utils/text.ts";
import { useLocale } from "../locale/LocaleProvider.tsx";
export function TokenWarning({ display, columns }: { display: HarnessDisplayState; columns: number }) {
	const ratio = display.contextWindow ? display.contextUsed / display.contextWindow : 0;
	const { t } = useLocale();
	return ratio >= 0.75 ? <ThemedText color={ratio >= 0.9 ? "error" : "warning"} wrap="truncate-end">{truncateText(t(`⚠ 上下文已用 ${Math.round(ratio * 100)}% · ${ratio >= 0.9 ? "接近容量上限" : "留意上下文容量"}`), columns)}</ThemedText> : null;
}
export function StatusLine({ mode, expanded, columns }: { display: HarnessDisplayState; mode: PermissionMode; expanded: boolean; columns: number }) {
	const { t } = useLocale();
	return <ThemedText color={mode === "yolo" ? "warning" : "accent"} wrap="truncate-end">{truncateText(`${mode} · Shift+Tab ${t("切换")}`, columns)}</ThemedText>;
}
