import { Box, Text } from "ink";
import { diffWordsWithSpace } from "diff";
import type { StructuredDiffHunk } from "../../harness/tools/diff.ts";
import { useTheme, ThemedText } from "../theme/ThemeProvider.tsx";
import { displayText, truncateText } from "../utils/text.ts";
import { useLocale } from "../locale/LocaleProvider.tsx";

export function StructuredDiff({ hunks, columns = 80, maxLines }: { hunks: readonly StructuredDiffHunk[]; columns?: number; maxLines?: number }) {
	const colors = useTheme();
	const { t } = useLocale();
	let rendered = 0, usedRows = 0;
	const total = hunks.reduce((sum, hunk) => sum + hunk.lines.length, 0);
	const gutter = String(Math.max(1, ...hunks.map(hunk => Math.max(hunk.oldStart + hunk.oldLines, hunk.newStart + hunk.newLines)))).length;
	return <Box flexDirection="column" width={Math.max(1, columns)}>
		{hunks.map((hunk, hi) => {
			let oldLine = hunk.oldStart, newLine = hunk.newStart;
			const showHeader = hunks.length > 1 && (maxLines === undefined || usedRows < maxLines);
			if (showHeader) usedRows++;
			return <Box key={hi} flexDirection="column">
				{showHeader ? <ThemedText color="dim" wrap="truncate-end">@@ -{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@</ThemedText> : null}
				{hunk.lines.map((line, index) => {
					const prefix = line[0], number = prefix === "-" ? oldLine++ : prefix === "+" ? newLine++ : newLine++;
					if (prefix === " ") oldLine++;
					if (prefix === "\\" || (maxLines !== undefined && usedRows >= maxLines)) return null;
					rendered++; usedRows++;
					// Hunks already contain one logical line. Its Windows line terminator is not another display row.
					const source = line.slice(1).replace(/\r$/, "");
					const content = maxLines === undefined ? displayText(source) : truncateText(source, Math.max(1, columns - gutter - 3));
					const foreground = prefix === "+" ? colors.accent : prefix === "-" ? colors.error : colors.muted;
					const background = prefix === "+" ? colors.diffAdded : prefix === "-" ? colors.diffRemoved : undefined;
					const partner = prefix === "-" ? hunk.lines.slice(index + 1).find(value => !value.startsWith("-"))
						: prefix === "+" ? hunk.lines.slice(0, index).reverse().find(value => value.startsWith("-")) : undefined;
					const partnerContent = partner ? displayText(partner.slice(1).replace(/\r$/, "")) : "";
					const changes = maxLines === undefined && partner && ((prefix === "-" && partner.startsWith("+")) || prefix === "+") && content.length < 3000
						? diffWordsWithSpace(prefix === "-" ? content : partnerContent, prefix === "+" ? content : partnerContent, { timeout: 30 }) : undefined;
					const similar = changes && changes.filter(change => !change.added && !change.removed).reduce((sum, change) => sum + change.value.length, 0) / Math.max(1, content.length) >= 0.4;
					return <Box key={index} backgroundColor={background || undefined}>
						<Text color={colors.dim || undefined}>{String(number).padStart(gutter)} </Text><Text color={foreground || undefined}>{prefix} </Text>
						<Box width={Math.max(1, columns - gutter - 3)}><Text color={foreground || undefined} wrap="wrap">{similar ? changes!.filter(change => prefix === "+" ? !change.removed : !change.added).map((change, ci) =>
							<Text key={ci} backgroundColor={(change.added ? colors.diffAddedWord : change.removed ? colors.diffRemovedWord : undefined) || undefined}>{displayText(change.value)}</Text>) : content}</Text></Box>
					</Box>;
				})}
			</Box>;
		})}
		{maxLines !== undefined && total > rendered ? <ThemedText color="dim">{truncateText(`… +${total - rendered} lines · Ctrl+O ${t("展开")}`, columns)}</ThemedText> : null}
	</Box>;
}
