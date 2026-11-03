import { memo, useMemo } from "react";
import { Box, Text } from "ink";
import hljs from "highlight.js/lib/common";
import { useTheme, ThemedText } from "../theme/ThemeProvider.tsx";
import { displayText, truncateText } from "../utils/text.ts";
interface CodeSpan { text: string; scope: string }
const entities: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#x27;": "'" };
function highlight(code: string, language: string): CodeSpan[][] {
	language = ({ tsx: "typescript", jsx: "javascript", ps1: "powershell", sh: "bash", md: "markdown" } as Record<string, string>)[language] ?? language;
	const safe = displayText(code);
	if (code.length > 100000 || !hljs.getLanguage(language)) return safe.split("\n").map(text => [{ text, scope: "" }]);
	const html = hljs.highlight(safe, { language, ignoreIllegals: true }).value;
	const rows: CodeSpan[][] = [[]], scopes: string[] = [];
	for (const part of html.split(/(<span class="[^"]+">|<\/span>)/g)) {
		if (part.startsWith("<span")) { scopes.push(/class="([^"]+)"/.exec(part)?.[1] ?? ""); continue; }
		if (part === "</span>") { scopes.pop(); continue; }
		const text = part.replace(/&(amp|lt|gt|quot|#x27);/g, entity => entities[entity] ?? entity);
		text.split("\n").forEach((line, index) => { if (index) rows.push([]); rows.at(-1)!.push({ text: line, scope: scopes.join(" ") }); });
	}
	return rows;
}
export const HighlightedCode = memo(function HighlightedCode({ code, language = "text", columns = 80, startLine = 1, maxLines, framed = true }: {
	code: string; language?: string; columns?: number; startLine?: number; maxLines?: number; framed?: boolean;
}) {
	const colors = useTheme(), lines = useMemo(() => highlight(code, language), [code, language]);
	const visible = maxLines ? lines.slice(0, maxLines) : lines;
	const gutter = String(startLine + visible.length - 1).length;
	return <Box flexDirection="column" width={Math.max(1, columns)} paddingLeft={framed ? 1 : 0}>
		{framed ? <ThemedText color="dim">{truncateText(language || "text", columns)}</ThemedText> : null}
		{visible.map((spans, index) => <Box key={index}><Text color={colors.dim || undefined}>{String(startLine + index).padStart(gutter)} │ </Text>
			<Box width={Math.max(1, columns - gutter - 3 - Number(framed))}><Text wrap="wrap">{spans.map((span, i) =>
				<Text key={i} color={/comment/.test(span.scope) ? colors.dim || undefined : /string|regexp/.test(span.scope) ? colors.accent || undefined
					: /keyword|literal|number/.test(span.scope) ? colors.brand || undefined : /title|function|type/.test(span.scope) ? colors.muted || undefined : undefined}>{span.text}</Text>)}</Text></Box>
		</Box>)}
		{maxLines && lines.length > maxLines ? <ThemedText color="dim">… +{lines.length - maxLines} lines</ThemedText> : null}
	</Box>;
});
