import stringWidth from "string-width";
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
/** External text never controls the terminal. Source data is preserved separately. */
export function displayText(text: string): string {
	// Windows tools emit CRLF; progress output may contain lone CR. Neither may reach an Ink text cell:
	// a literal CR resets the physical cursor in the middle of a padded row and scatters its borders.
	return text.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu, "�").replace(/\t/g, "    ");
}
export function truncateText(text: string, columns: number, ellipsis = "…"): string {
	const safe = displayText(text).replace(/[\r\n]/g, " ");
	if (columns <= 0) return "";
	if (stringWidth(safe) <= columns) return safe;
	let result = "", width = 0;
	for (const { segment } of segmenter.segment(safe)) {
		const next = stringWidth(segment);
		if (width + next > columns - stringWidth(ellipsis)) break;
		result += segment; width += next;
	}
	return result + ellipsis;
}
export function wrapText(text: string, columns: number): string[] {
	const result: string[] = [];
	for (const line of displayText(text).replace(/\r\n?/g, "\n").split("\n")) {
		let row = "", width = 0;
		for (const { segment } of segmenter.segment(line)) {
			const size = stringWidth(segment);
			if (width + size > Math.max(1, columns) && row) { result.push(row); row = ""; width = 0; }
			row += size > columns ? "�" : segment; width += Math.min(size, Math.max(1, columns));
		}
		result.push(row);
	}
	return result;
}
export function formatTokens(value: number): string { return value >= 1000 ? `${Number((value / 1000).toFixed(1))}k` : String(value); }
