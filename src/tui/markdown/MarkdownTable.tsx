import { Box, Text } from "ink";
import stringWidth from "string-width";
import { ThemedText } from "../theme/ThemeProvider.tsx";
import { wrapText } from "../utils/text.ts";
export function MarkdownTable({ header, rows, columns }: { header: string[]; rows: string[][]; columns: number }) {
	const count = header.length;
	if (!count) return null;
	if (columns < count * 7 + 1) return <Box flexDirection="column">{rows.map((row, i) => <Box key={i} flexDirection="column" marginBottom={1}>
		{header.map((cell, j) => <Text key={j}><ThemedText color="accent">{cell}: </ThemedText>{row[j] ?? ""}</Text>)}
	</Box>)}</Box>;
	const room = Math.max(count, columns - count * 3 - 1);
	const widths = header.map((cell, i) => Math.max(3, Math.min(40, stringWidth(cell), room)));
	for (let i = 0; i < count; i++) widths[i] = Math.min(40, Math.max(widths[i]!, ...rows.map(row => stringWidth(row[i] ?? ""))));
	while (widths.reduce((sum, width) => sum + width, 0) > room) { const largest = Math.max(...widths); widths[widths.indexOf(largest)]!--; }
	const border = (left: string, middle: string, right: string) => <ThemedText color="faint">{left}{widths.map(width => "─".repeat(width + 2)).join(middle)}{right}</ThemedText>;
	const renderRow = (row: string[], bold: boolean, key: number) => {
		const cells = widths.map((width, i) => wrapText(row[i] ?? "", width));
		return Array.from({ length: Math.max(1, ...cells.map(cell => cell.length)) }, (_, line) => <Text key={`${key}-${line}`}>
			<ThemedText color="faint">│ </ThemedText>{widths.map((width, i) => {
				const value = cells[i]![line] ?? "";
				return <Text key={i}><Text bold={bold}>{value}{" ".repeat(Math.max(0, width - stringWidth(value)))}</Text><ThemedText color="faint"> {i === count - 1 ? "│" : "│ "}</ThemedText></Text>;
			})}</Text>);
	};
	return <Box flexDirection="column">{border("┌", "┬", "┐")}{renderRow(header, true, -1)}{border("├", "┼", "┤")}
		{rows.map((row, index) => renderRow(row, false, index))}{border("└", "┴", "┘")}</Box>;
}
