import { Box, Text } from "ink";
import { useTheme } from "../theme/ThemeProvider.tsx";
import { BRAND_ART, BRAND_ART_WIDTH } from "./brand-art.ts";

/** Keep palette/NO_COLOR colors intact; truecolor gets vertical shading and a darker bolt edge. */
function shade(color: string, strength: number): string | undefined {
	if (!color) return undefined;
	if (!/^#[\da-f]{6}$/i.test(color)) return color;
	return "#" + [1, 3, 5].map(offset => Math.round(parseInt(color.slice(offset, offset + 2), 16) * strength).toString(16).padStart(2, "0")).join("");
}

/** Fixed art, explicit one-row tracks, and clipping before layout prevent physical terminal wrapping. */
export function BrandMark({ columns }: { columns: number }) {
	const { brand, accent } = useTheme(), width = Math.max(0, Math.min(BRAND_ART_WIDTH, columns));
	const strengths = [1, 1, 0.94, 0.94, 0.8, 0.68];
	return <Box width={width} height={BRAND_ART.length} flexDirection="column" flexGrow={0} flexShrink={0} overflow="hidden">
		{BRAND_ART.map(([left, lightning, right], row) => {
			// Every character in this fixed asset occupies one cell. Never pass an oversized row to Ink.
			const line = (left + lightning + right).slice(0, width), end = left.length + lightning.length;
			const bolt = line.slice(left.length, end), strength = strengths[row]!;
			return <Box key={row} width={width} height={1} flexShrink={0}>
				<Text color={shade(brand, strength)} wrap="truncate-end" aria-label={row === 0 ? "ANTITRACE" : undefined} aria-hidden={row !== 0}>
					{line.slice(0, left.length)}<Text color={shade(accent, strength)}>{bolt.split(/([╔╗╚╝═║]+)/).map((part, index) =>
						<Text key={index} color={shade(accent, /^[╔╗╚╝═║]+$/.test(part) ? strength * 0.72 : strength)}>{part}</Text>)}</Text>{line.slice(end)}
				</Text>
			</Box>;
		})}
	</Box>;
}
