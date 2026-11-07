import { type ReactNode } from "react";
import { Box, Text } from "ink";
import { Lexer, type Tokens } from "marked";
import { translate, type UiLanguage } from "../../cli/locale.ts";
import { type TranscriptGroup, TranscriptItemView } from "../messages/TranscriptView.tsx";
import { MessageFrame, frameContentColumns } from "../messages/MessageFrame.tsx";
import { AssistantThinkingMessage } from "../messages/AssistantThinkingMessage.tsx";
import { MarkdownTokens } from "../markdown/Markdown.tsx";
import { HighlightedCode, highlightCode } from "../markdown/HighlightedCode.tsx";
import { ThemedText } from "../theme/ThemeProvider.tsx";
import type { TerminalTheme } from "../theme/theme.ts";
import { displayText, wrapText } from "../utils/text.ts";
import { RowRenderer } from "./RowRenderer.tsx";
import type { TerminalRows } from "./terminal-rows.ts";
import type { TranscriptAnchor } from "../viewport-state.ts";
import { LazyRows, RowIndex } from "./row-index.ts";

interface LayoutOptions { columns: number; expanded: boolean; thinkingDisplay: boolean; theme: TerminalTheme; language: UiLanguage }
interface Part { key: string; input: unknown; node: ReactNode; estimate?: number; crop?: (rows: string[]) => string[] }
interface Entry extends TerminalRows { input: unknown; rows?: string[]; bytes: number; node: ReactNode; crop?: Part["crop"]; options: LayoutOptions }
interface ItemLayout { input: TranscriptGroup; parts: Map<string, Entry>; rows: LazyRows }
interface Variant { items: Map<number, ItemLayout>; header?: Entry }
interface Location { id: number; tool: boolean; running: boolean }

/** The height index is separate from the bounded row cache, so eviction does not move reading anchors. */
export class TranscriptLayout implements TerminalRows {
	private readonly byId: Map<number, number>;
	private readonly running: number[];
	readonly lastTool?: TranscriptAnchor;
	constructor(private readonly rows: RowIndex, private readonly locations: readonly Location[]) {
		this.byId = new Map(locations.map((item, index) => [item.id, index + 1]));
		this.running = locations.filter(item => item.running).map(item => item.id);
		let tool: Location | undefined;
		for (let i = locations.length - 1; i >= 0; i--) if (locations[i]!.tool) { tool = locations[i]; break; }
		if (tool) this.lastTool = { id: tool.id, row: 0 };
	}
	get length(): number { return this.rows.length; }
	animatedRows(top: number, height: number): number[] {
		return this.running.map(id => (this.resolve({ id, row: 0 }) ?? -3) + 2 - top).filter(row => row >= 0 && row < height);
	}
	slice(start: number, end?: number): string[] { return this.rows.slice(start, end); }
	ensureTail(height: number): void { this.rows.ensureTail(height); }
	ensureAnchor(anchor: TranscriptAnchor | undefined, height: number): void {
		const index = anchor ? this.byId.get(anchor.id) ?? 0 : 0;
		this.rows.ensureBefore(index, 8);
		this.rows.ensureFrom(index, height, Math.max(0, (anchor?.row ?? 0) - 8));
	}
	resolve(anchor?: TranscriptAnchor): number | undefined {
		const index = anchor && this.byId.get(anchor.id);
		return index !== undefined && anchor ? this.rows.top(index) + Math.min(anchor.row, Math.max(0, this.rows.height(index) - 1)) : undefined;
	}
	anchor(top: number): TranscriptAnchor | undefined {
		const index = Math.max(1, this.rows.locate(top)), item = this.locations[index - 1];
		return item ? { id: item.id, row: top - this.rows.top(index) } : undefined;
	}
}

/** Stable messages are laid out once. Keystrokes, scroll and animation never measure the history tree.
 * Row payloads use an LRU byte budget; metadata and source messages survive eviction.
 */
export class TranscriptLayoutCache {
	private readonly renderer = new RowRenderer();
	private readonly lru = new Map<Entry, true>();
	private bytes = 0;
	private options?: LayoutOptions;
	private items = new Map<number, ItemLayout>();
	private readonly variants = new Map<string, Variant>();
	constructor(private readonly byteBudget = 8 * 1024 * 1024) {}
	get cachedBytes(): number { return this.bytes; }
	private read(entry: Entry): string[] {
		this.lru.delete(entry);
		if (!entry.rows) {
			const { columns, theme, language } = entry.options;
			const rows = this.renderer.rows(entry.node, columns, theme, language);
			entry.rows = entry.crop ? entry.crop(rows) : rows;
			entry.bytes = entry.rows.reduce((n, row) => n + row.length * 2, 0);
			this.bytes += entry.bytes;
		}
		this.lru.set(entry, true);
		const rows = entry.rows;
		while (this.lru.size && (this.bytes > this.byteBudget || this.lru.size > 2048)) {
			const oldest = this.lru.keys().next().value!;
			this.lru.delete(oldest); this.bytes -= oldest.bytes; oldest.rows = undefined;
		}
		return rows;
	}
	private entry(part: Part, options: LayoutOptions, old?: Entry): Entry {
		if (old && old.input === part.input) return old;
		if (old && this.lru.delete(old)) { this.bytes -= old.bytes; old.rows = undefined; }
		const entry: Entry = { ...part, options, bytes: 0, length: 0, slice: (start, end) => this.read(entry).slice(start, end) };
		Object.defineProperty(entry, "length", { value: this.read(entry).length });
		return entry;
	}
	prepare(items: readonly TranscriptGroup[], header: ReactNode, headerKey: string, options: LayoutOptions): TranscriptLayout {
		const previous = this.options;
		if ((previous && previous.theme !== options.theme) || (this.items.size > 0 && (!items.length || !this.items.has(items[0]!.id)))) this.clear();
		this.options = options;
		const key = `${options.columns}:${options.expanded}:${options.thinkingDisplay}:${options.language}`;
		const variant = this.variants.get(key) ?? { items: new Map<number, ItemLayout>() };
		this.variants.delete(key); this.variants.set(key, variant);
		while (this.variants.size > 4) this.variants.delete(this.variants.keys().next().value!);
		variant.header = this.entry({ key: "header", input: headerKey, node: header }, options, variant.header);
		const headerRows = variant.header;
		const parts: LazyRows[] = [new LazyRows(headerRows.length, () => headerRows)], locations: Location[] = [], nextItems = new Map<number, ItemLayout>();
		for (const item of items) {
			let cached = variant.items.get(item.id);
			const same = cached?.input === item || (cached?.input.kind === "reads" && item.kind === "reads"
				&& cached.input.items.length === item.items.length && cached.input.items.every((value, index) => value === item.items[index]));
			if (!same) {
				const oldParts = cached?.parts, entries = new Map<string, Entry>();
				cached = { input: item, parts: entries, rows: new LazyRows(cached?.rows.length ?? this.items.get(item.id)?.rows.length ?? 1, () => {
					return new RowIndex(this.parts(item, options).map(part => {
						const old = oldParts?.get(part.key);
						if (old && old.input === part.input) entries.set(part.key, old);
						return new LazyRows(old?.length ?? part.estimate ?? 1, () => {
							const entry = this.entry(part, options, old); entries.set(part.key, entry); return entry;
						});
					}));
				}) };
			}
			nextItems.set(item.id, cached!); parts.push(cached!.rows);
			locations.push({ id: item.id, tool: item.kind === "tool" || item.kind === "reads", running: item.kind === "tool" && item.status === "running" });
		}
		this.items = nextItems; variant.items = nextItems;
		return new TranscriptLayout(new RowIndex(parts), locations);
	}
	private parts(item: TranscriptGroup, options: LayoutOptions): Part[] {
		const { columns, expanded, thinkingDisplay, language } = options;
		if (item.kind !== "assistant") return [{ key: "item", input: item, node: <TranscriptItemView item={item} {...options} /> }];
		const parts: Part[] = [], width = frameContentColumns(columns);
		for (const block of item.blocks) {
			if (!block.text) continue;
			const prefix = String(block.index);
			if (block.kind === "thinking") {
				const title = <AssistantThinkingMessage text=" " expanded={expanded || thinkingDisplay} durationMs={item.durationMs} columns={columns} />;
				parts.push({ key: `${prefix}:title`, input: item.durationMs, node: title, estimate: 1, crop: rows => rows.slice(0, 1) });
				if (expanded || thinkingDisplay) {
					const rows = wrapText(block.text, Math.max(1, columns - 2));
					for (let i = 0; i < rows.length; i += 64) {
						const text = rows.slice(i, i + 64).join("\n");
						parts.push({ key: `${prefix}:${i}`, input: text, estimate: Math.min(64, rows.length - i), node: <Box width={columns}><Box width={2}><ThemedText color="dim">{i === 0 ? "▎ " : "  "}</ThemedText></Box><Box width={Math.max(1, columns - 2)}><ThemedText color="muted">{text}</ThemedText></Box></Box> });
					}
				}
				continue;
			}
			const frame = (node: ReactNode) => <MessageFrame kind="reply" columns={columns}>{node}</MessageFrame>;
			const chrome = frame(<ThemedText color="brand" bold>{translate("回复", language)}</ThemedText>);
			parts.push({ key: `${prefix}:title`, input: "title", node: chrome, estimate: 3, crop: rows => rows.slice(0, -1) });
			const tokens = Lexer.lex(displayText(block.text), { gfm: true }).filter(token => token.type !== "space" && token.type !== "def");
			tokens.forEach((token, index) => {
				if (index) parts.push({ key: `${prefix}:${index}:gap`, input: "gap", node: frame(<Text> </Text>), crop: rows => rows.slice(2, -1) });
				if (token.type === "code") {
					const code = token as Tokens.Code, lines = code.text.split("\n"), language = code.lang?.split(/\s/)[0] || "text";
					// Highlight once with the full lexical context (e.g. multiline comments), then lay out bounded segments.
					const highlighted = highlightCode(code.text, language);
					for (let i = 0; i < lines.length; i += 64) {
						const text = lines.slice(i, i + 64).join("\n"), gutterWidth = String(lines.length).length, highlightedLines = highlighted.slice(i, i + 64);
						parts.push({ key: `${prefix}:${index}:${i}`, input: `${language}:${gutterWidth}:${JSON.stringify(highlightedLines)}`, estimate: highlightedLines.length + Number(i === 0), crop: rows => rows.slice(2, -1), node: frame(
							<HighlightedCode code={text} highlightedLines={highlightedLines} language={language} columns={width} startLine={i + 1} gutterWidth={gutterWidth} showLanguage={i === 0} />) });
					}
				} else parts.push({ key: `${prefix}:${index}`, input: JSON.stringify(token), node: frame(<MarkdownTokens tokens={[token]} columns={width} />), crop: rows => rows.slice(2, -1) });
			});
			parts.push({ key: `${prefix}:bottom`, input: "bottom", node: chrome, crop: rows => rows.slice(-1) });
		}
		return parts;
	}
	private clear(): void {
		for (const entry of this.lru.keys()) entry.rows = undefined;
		this.items.clear(); this.variants.clear(); this.lru.clear(); this.bytes = 0;
	}
	dispose(): void { this.renderer.dispose(); this.clear(); }
}
