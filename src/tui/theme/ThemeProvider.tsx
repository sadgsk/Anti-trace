import { createContext, useContext, useMemo, type ReactNode, type ComponentProps } from "react";
import { Box, Text } from "ink";
import { resolveTheme, type ColorDepth, type RGB } from "./color.ts";
import { theme, type TerminalTheme, type ThemeColorKey } from "./theme.ts";

const ThemeContext = createContext<TerminalTheme>(theme);
export const ThemeSnapshotProvider = ThemeContext.Provider;
export function ThemeProvider({ depth = 24, paper, children }: { depth?: ColorDepth; paper?: RGB; children: ReactNode }) {
	const value = useMemo(() => resolveTheme(depth, paper), [depth, paper]);
	return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}
export const useTheme = () => useContext(ThemeContext);
export function ThemedText({ color, ...props }: Omit<ComponentProps<typeof Text>, "color"> & { color?: ThemeColorKey }) {
	const colors = useTheme();
	return <Text {...props} color={colors[color ?? "brand"] || undefined} />;
}
export function ThemedBox({ color, ...props }: Omit<ComponentProps<typeof Box>, "borderColor"> & { color?: ThemeColorKey }) {
	const colors = useTheme();
	return <Box {...props} borderColor={color ? colors[color] || undefined : undefined} />;
}
