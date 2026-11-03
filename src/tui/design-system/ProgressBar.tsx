import { Text } from "ink";
import { ThemedText } from "../theme/ThemeProvider.tsx";
import type { ThemeColorKey } from "../theme/theme.ts";
export function ProgressBar({ ratio, width = 16, fillColor = "accent", emptyColor = "faint" }: {
	ratio: number; width?: number; fillColor?: ThemeColorKey; emptyColor?: ThemeColorKey;
}) {
	const value = Number.isFinite(ratio) ? Math.max(0, Math.min(1, ratio)) : 0;
	if (width < 10) return <Text>{Math.round(value * 100)}%</Text>;
	const units = Math.round(value * width * 8), full = Math.floor(units / 8), partial = units % 8;
	return <Text><ThemedText color={fillColor}>{"█".repeat(full)}{partial ? "▏▎▍▌▋▊▉"[partial - 1] : ""}</ThemedText>
		<ThemedText color={emptyColor}>{"░".repeat(Math.max(0, width - full - Number(partial > 0)))}</ThemedText></Text>;
}
