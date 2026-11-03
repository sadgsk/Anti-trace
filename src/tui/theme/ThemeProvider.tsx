import { createContext, useContext, useMemo, type ReactNode, type ComponentProps } from "react";
import { Box, Text } from "ink";
import { resolveTheme, type ColorDepth } from "./color.ts";
import { theme, type TerminalTheme, type ThemeColorKey } from "./theme.ts";

const ThemeContext = createContext<TerminalTheme>(theme);
export function ThemeProvider({ depth = 24, children }: { depth?: ColorDepth; children: ReactNode }) {
	const value = useMemo(() => resolveTheme(depth), [depth]);
	return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}
export const useTheme = () => useContext(ThemeContext);
export function ThemedText({ color, ...props }: Omit<ComponentProps<typeof Text>, "color"> & { color?: ThemeColorKey }) {
	const colors = useTheme();
	return <Text {...props} color={color ? colors[color] || undefined : undefined} />;
}
export function ThemedBox({ color, ...props }: Omit<ComponentProps<typeof Box>, "borderColor"> & { color?: ThemeColorKey }) {
	const colors = useTheme();
	return <Box {...props} borderColor={color ? colors[color] || undefined : undefined} />;
}
