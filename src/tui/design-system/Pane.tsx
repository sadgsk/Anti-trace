import { Box, type BoxProps } from "ink";
import type { ReactNode } from "react";
import stringWidth from "string-width";
import { ThemedText, useTheme } from "../theme/ThemeProvider.tsx";
import { frameContentColumns } from "../messages/MessageFrame.tsx";
import { truncateText } from "../utils/text.ts";

export const cutBorder = { topLeft: "╭", top: "─", topRight: "┐", left: "│", right: "│", bottomLeft: "└", bottom: "─", bottomRight: "╯" };

/** Keep the conversation beside a wide panel or above a compact one. */
export function dialogLayout(columns: number, rows: number) {
	const height = Math.max(1, rows - 1);
	if (columns >= 78 && rows >= 15) return { position: "side" as const, width: Math.max(35, Math.min(66, Math.floor(columns * 0.42))), height };
	if (columns >= 32 && rows >= 18) return { position: "stack" as const, width: frameContentColumns(columns), height: Math.max(12, Math.floor(height * 0.65)) };
	return { position: "solo" as const, width: columns, height };
}

export function Pane({ children, ...props }: BoxProps & { children: ReactNode }) {
	const { brand } = useTheme();
	return <Box flexDirection="column" borderStyle={cutBorder} borderColor={brand || undefined} paddingX={1} {...props}>{children}</Box>;
}

export function PanelTitle({ title, width }: { title: string; width: number }) {
	const label = truncateText(title, Math.max(1, width - 7));
	return <ThemedText wrap="truncate-end">◇ ◢<ThemedText bold>{" " + label + " "}</ThemedText>◤ {"─".repeat(Math.max(0, width - stringWidth(label) - 7))}</ThemedText>;
}
