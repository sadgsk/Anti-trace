import { Text } from "ink";
import { ThemedText } from "../theme/ThemeProvider.tsx";
import { entranceGlyph, lastLogoFrame, logoLines, logoWidth } from "./brand-art.ts";

export function BrandMark({ columns, band, frame = lastLogoFrame, graphic }: { columns: number; band: number; frame?: number; graphic?: boolean }) {
	return graphic ? <Text>{String.fromCharCode(entranceGlyph + frame).padEnd(logoWidth(columns))}</Text>
		: <ThemedText aria-label={band === 0 ? "ResidualX" : undefined} aria-hidden={band !== 0}>{logoLines(frame, columns)[band]}</ThemedText>;
}
