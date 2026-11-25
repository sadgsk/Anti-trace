import { vectorTheme, type TerminalTheme } from "./theme.ts";

export type ColorDepth = 0 | 4 | 8 | 24;
export function detectColorDepth(stream: Pick<NodeJS.WriteStream, "isTTY" | "getColorDepth">, env: NodeJS.ProcessEnv = process.env): ColorDepth {
	if (env.NO_COLOR !== undefined || env.TERM === "dumb" || env.FORCE_COLOR === "0") return 0;
	if (env.FORCE_COLOR) return env.FORCE_COLOR === "3" ? 24 : env.FORCE_COLOR === "2" ? 8 : 4;
	if (!stream.isTTY) return 0;
	const depth = stream.getColorDepth?.(env) ?? (env.COLORTERM?.includes("color") ? 24 : 8);
	return depth >= 24 ? 24 : depth >= 8 ? 8 : 4;
}

export type RGB = readonly [number, number, number];

function luminance(rgb: RGB): number {
	const [r, g, b] = rgb.map(channel => {
		const s = channel / 255;
		return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
	});
	return r! * 0.2126 + g! * 0.7152 + b! * 0.0722;
}

export function vectorInk(paper: RGB): RGB {
	const lightness = luminance(paper) + 0.05;
	const dark: RGB = [16, 16, 16];
	return 1.05 / lightness >= lightness / (luminance(dark) + 0.05) ? [255, 255, 255] : dark;
}

export function resolveTheme(depth: ColorDepth, paper?: RGB): TerminalTheme {
	if (!paper || !depth) return vectorTheme();
	const white = vectorInk(paper)[0] === 255;
	if (depth === 24) return vectorTheme(white ? "#FFFFFF" : "#101010");
	if (depth === 8) return vectorTheme(white ? "ansi256(231)" : "ansi256(233)");
	return vectorTheme(white ? "whiteBright" : "black");
}
