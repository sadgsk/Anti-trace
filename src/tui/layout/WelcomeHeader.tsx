import { createRequire } from "node:module";
import { Box } from "ink";
import { ThemedText } from "../theme/ThemeProvider.tsx";
import { displayText } from "../utils/text.ts";
import { BrandMark } from "./BrandMark.tsx";
import { hasLargeLogo, logoHeight, logoWidth } from "./brand-art.ts";

const { version } = createRequire(import.meta.url)("../../../package.json") as { version: string };
const versionLabel = "v" + version;

/** Static scrollback and the moving wordmark use the same terminal cells. */
export function WelcomeRow({ columns, brandColumns, cwd, band, frame, graphic, compact = false }: {
	columns: number; brandColumns: number; cwd: string; band: number; frame?: number; graphic?: boolean; compact?: boolean;
}) {
	const markWidth = compact ? Math.min(9, columns) : logoWidth(brandColumns);
	const space = columns - markWidth - 3;
	const versionBand = compact ? 0 : logoHeight(brandColumns) - (space >= 8 ? 2 : 1);
	const showVersion = space >= versionLabel.length && band === versionBand;
	const showPath = compact ? space >= versionLabel.length + 12 : space >= 8 && band === versionBand + 1;
	return <Box height={1} width={columns} flexShrink={0}>
		<Box width={markWidth} flexShrink={0}>{compact ? <ThemedText bold wrap="truncate-end">ResidualX</ThemedText>
			: <BrandMark columns={brandColumns} band={band} frame={frame} graphic={graphic} />}</Box>
		{(showVersion || showPath) && <Box flexGrow={1} marginLeft={3} justifyContent="flex-end">
			{showVersion && <Box flexShrink={0} marginRight={showPath ? 2 : 0}><ThemedText>{versionLabel}</ThemedText></Box>}
			{showPath && <ThemedText wrap="truncate-start">{displayText(cwd).replace(/\n/g, " ")}</ThemedText>}
		</Box>}
	</Box>;
}

export function WelcomeHeader({ columns, brandColumns = columns, rows, cwd, gap = true }: { columns: number; brandColumns?: number; rows: number; cwd: string; gap?: boolean }) {
	const compact = !hasLargeLogo(columns, rows);
	return <Box flexDirection="column" paddingBottom={gap ? 1 : 0}>{Array.from({ length: compact ? 1 : logoHeight(brandColumns) }, (_, band) =>
		<WelcomeRow key={band} columns={columns} brandColumns={brandColumns} cwd={cwd} band={band} compact={compact} />
	)}</Box>;
}
