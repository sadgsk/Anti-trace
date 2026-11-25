/** All semantic foregrounds share one ink. The terminal owns the canvas. */
export function vectorTheme(ink = "") {
	return {
		brand: ink, accent: ink, error: ink, muted: ink, dim: ink, faint: ink,
		success: ink, warning: ink, permission: ink,
	};
}
export const theme = vectorTheme();
export type TerminalTheme = ReturnType<typeof vectorTheme>;
export type ThemeColorKey = keyof TerminalTheme;
