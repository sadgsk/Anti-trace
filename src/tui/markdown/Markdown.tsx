import { memo, useMemo, type ReactNode } from "react";
import { Box, Text } from "ink";
import { Lexer, type Token, type Tokens } from "marked";
import { ThemedText } from "../theme/ThemeProvider.tsx";
import { displayText } from "../utils/text.ts";
import { HighlightedCode } from "./HighlightedCode.tsx";
import { MarkdownTable } from "./MarkdownTable.tsx";
import { FilePathLink } from "./FilePathLink.tsx";
import { Divider } from "../design-system/Divider.tsx";

function inline(tokens: readonly Token[] | undefined, fallback = ""): ReactNode {
	if (!tokens) return displayText(fallback);
	return tokens.map((token, index) => {
		const node = token as Token & { text?: string; tokens?: Token[]; href?: string };
		const children = inline(node.tokens, node.text ?? "");
		switch (token.type) {
			case "strong": return <Text key={index} bold>{children}</Text>;
			case "em": return <Text key={index} italic>{children}</Text>;
			case "del": return <Text key={index} strikethrough>{children}</Text>;
			case "codespan": return <ThemedText key={index} color="accent">{displayText(node.text ?? "")}</ThemedText>;
			case "link": return <FilePathLink key={index} href={node.href ?? ""}>{node.text}</FilePathLink>;
			case "image": return <ThemedText key={index} color="muted">[Image: {displayText(node.text ?? "")}]</ThemedText>;
			case "br": return "\n";
			default: return <Text key={index}>{children}</Text>;
		}
	});
}
function blocks(tokens: readonly Token[], columns: number, depth = 0): ReactNode {
	if (depth > 12) return <Text>{tokens.map(token => token.raw).join("")}</Text>;
	return tokens.map((token, index) => {
		switch (token.type) {
			case "space": case "def": return null;
			case "heading": { const h = token as Tokens.Heading; return <ThemedText key={index} color={h.depth === 1 ? "brand" : "accent"} bold>{inline(h.tokens)}</ThemedText>; }
			case "code": { const code = token as Tokens.Code; return <HighlightedCode key={index} code={code.text} language={code.lang?.split(/\s/)[0]} columns={columns} />; }
			case "hr": return <Divider key={index} width={columns} color="faint" />;
			case "blockquote": return <Box key={index}><ThemedText color="dim">▎ </ThemedText><Box flexDirection="column" width={Math.max(1, columns - 2)}>{blocks((token as Tokens.Blockquote).tokens, columns - 2, depth + 1)}</Box></Box>;
			case "list": { const list = token as Tokens.List; return <Box key={index} flexDirection="column">{list.items.map((item, i) => {
				const marker = item.task ? item.checked ? "[x] " : "[ ] " : list.ordered ? `${Number(list.start) + i}. ` : "• ";
				return <Box key={i}><ThemedText color="muted">{marker}</ThemedText><Box flexDirection="column" width={Math.max(1, columns - marker.length)}>{blocks(item.tokens, columns - marker.length, depth + 1)}</Box></Box>;
			})}</Box>; }
			case "table": { const table = token as Tokens.Table; return <MarkdownTable key={index} header={table.header.map(cell => cell.text)} rows={table.rows.map(row => row.map(cell => cell.text))} columns={columns} />; }
			default: { const text = token as Tokens.Paragraph; return <Text key={index}>{inline(text.tokens, text.text ?? text.raw)}</Text>; }
		}
	});
}
export const Markdown = memo(function Markdown({ text, columns = 80 }: { text: string; columns?: number }) {
	const tokens = useMemo(() => Lexer.lex(displayText(text), { gfm: true }), [text]);
	return <MarkdownTokens tokens={tokens} columns={columns} />;
});
/** Also used by the transcript layout cache, which lays out independent Markdown blocks. */
export function MarkdownTokens({ tokens, columns }: { tokens: readonly Token[]; columns: number }) {
	return <Box flexDirection="column" gap={1} width={Math.max(1, columns)}>{blocks(tokens, Math.max(1, columns))}</Box>;
}
