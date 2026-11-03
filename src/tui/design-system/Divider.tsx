import { Text } from "ink";
import stringWidth from "string-width";
import { useTheme } from "../theme/ThemeProvider.tsx";
import type { ThemeColorKey } from "../theme/theme.ts";
import { truncateText } from "../utils/text.ts";
export function Divider({ width = 80, color = "dim", char = "─", title, padding = 0 }: {
	width?: number; color?: ThemeColorKey; char?: "─" | "━" | "▔"; title?: string; padding?: number;
}) {
	const colors = useTheme(), count = Math.max(0, width - padding);
	const label = title ? truncateText(` ${title} `, count) : "";
	const sides = Math.max(0, count - stringWidth(label)), left = Math.floor(sides / 2);
	return count ? <Text color={colors[color] || undefined} wrap="truncate-end">{char.repeat(left)}{label}{char.repeat(sides - left)}</Text> : null;
}
