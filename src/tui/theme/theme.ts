/** DesignCraft tokens.css + prototype.css. Ink handles terminal color-depth fallback. */
export const theme = {
	brand: "#FCEE0A",
	accent: "#00F0FF",
	error: "#FF003C",
	bg: "#030408",
	bgBar: "#05070D",
	muted: "#898D99",
	dim: "#393B42",
	faint: "#1E2025",
	/** P09: rgba(0, 240, 255, .055) composited over the menu background. */
	selectionBackground: "#051418",
	success: "#00F0FF",
	warning: "#FCEE0A",
	permission: "#00F0FF",
	diffAdded: "#062025",
	diffRemoved: "#260812",
	diffAddedWord: "#07434A",
	diffRemovedWord: "#5A1025",
} as const;

export type ThemeColorKey = keyof typeof theme;
export type TerminalTheme = { readonly [K in ThemeColorKey]: string };
