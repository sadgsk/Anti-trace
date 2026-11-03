import type { ReactNode } from "react";
import { Box, Text } from "ink";
import { useTheme } from "../theme/ThemeProvider.tsx";
export function ListItem({ selected, disabled, children, width }: { selected?: boolean; disabled?: boolean; children: ReactNode; width?: number }) {
	const colors = useTheme();
	return <Box width={width} height={1} backgroundColor={selected ? colors.selectionBackground || undefined : undefined}>
		<Text color={selected ? colors.accent || undefined : colors.muted || undefined} dimColor={disabled} wrap="truncate-end">{selected ? "❯ " : "  "}{children}</Text>
	</Box>;
}
