import { KeyboardShortcutHint } from "../design-system/KeyboardShortcutHint.tsx";
import { useLocale } from "../locale/LocaleProvider.tsx";
export function CtrlOToExpand({ expanded = false }: { expanded?: boolean }) {
	const { t } = useLocale();
	return <KeyboardShortcutHint shortcut="Ctrl+O" action={t(expanded ? "收起" : "展开")} parens bold={false} />;
}
