import { Box, type BoxProps } from "ink";
import type { ReactNode } from "react";
import { useTheme } from "../theme/ThemeProvider.tsx";
import type { ThemeColorKey } from "../theme/theme.ts";
export function Pane({ color = "accent", children, ...props }: BoxProps & { color?: ThemeColorKey; children: ReactNode }) {
	const colors = useTheme();
	return <Box flexDirection="column" borderStyle="round" borderColor={colors.faint || undefined}
		borderTopColor={colors[color] || undefined} paddingX={1} {...props}>{children}</Box>;
}
