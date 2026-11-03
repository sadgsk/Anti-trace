import { theme, type TerminalTheme } from "./theme.ts";

export type ColorDepth = 0 | 4 | 8 | 24;
export function detectColorDepth(stream: Pick<NodeJS.WriteStream, "isTTY" | "getColorDepth">, env: NodeJS.ProcessEnv = process.env): ColorDepth {
	if (env.NO_COLOR !== undefined || env.TERM === "dumb" || env.FORCE_COLOR === "0") return 0;
	if (env.FORCE_COLOR) return env.FORCE_COLOR === "3" ? 24 : env.FORCE_COLOR === "2" ? 8 : 4;
	if (!stream.isTTY) return 0;
	const depth = stream.getColorDepth?.(env) ?? (env.COLORTERM?.includes("color") ? 24 : 8);
	return depth >= 24 ? 24 : depth >= 8 ? 8 : 4;
}

export function resolveTheme(depth: ColorDepth): TerminalTheme {
	if (depth === 24) return theme;
	const mapping: Record<string, string> = {
		[theme.brand]: depth >= 8 ? "ansi256(226)" : "yellowBright",
		[theme.accent]: depth >= 8 ? "ansi256(51)" : "cyanBright",
		[theme.error]: depth >= 8 ? "ansi256(197)" : "redBright",
		[theme.muted]: depth >= 8 ? "ansi256(245)" : "gray",
		[theme.dim]: depth >= 8 ? "ansi256(239)" : "gray",
		[theme.faint]: depth >= 8 ? "ansi256(235)" : "gray",
	};
	return Object.fromEntries(Object.entries(theme).map(([key, value]) => [key,
		depth === 0 ? "" : mapping[value] ?? (depth >= 8 ? key === "diffRemovedWord" ? "ansi256(52)" : key === "diffAddedWord" ? "ansi256(23)"
			: key.startsWith("diffRemoved") ? "ansi256(233)" : key.startsWith("diffAdded") ? "ansi256(234)" : "ansi256(232)" : "black")])) as unknown as TerminalTheme;
}
