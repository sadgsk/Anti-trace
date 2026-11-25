import { type ReactNode } from "react";
import { Box, Text } from "ink";
import { Lexer, type Tokens } from "marked";
import { type UiLanguage } from "../../cli/locale.ts";
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

interface LayoutOptions { columns: number; railOffset?: number; expanded: boolean; thinkingDisplay: boolean; theme: TerminalTheme; language: UiLanguage; thinkingId?: number }
interface Part { key: string; input: unknown; node: ReactNode; thinkingHeading?: boolean; estimate?: number; crop?: (rows: string[]) => string[] }
interface Entry extends TerminalRows { header: boolean; input: unknown; rows?: string[]; bytes: number; node: ReactNode; crop?: Part["crop"]; options: LayoutOptions }
interface ItemLayout { pending: boolean; input: TranscriptGroup; parts: Map<string, Entry>; rows: LazyRows; headingOffset?: () => number }
interface Variant { items: Map<number, ItemLayout>; header?: Entry }
interface Location { id: number; tool: boolean }

/** The height index is separate from the bounded row cache, so eviction does not move reading anchors. */
export class TranscriptLayout implements TerminalRows {
	private readonly byId: Map<number, number>;
	readonly lastTool?: TranscriptAnchor;
	constructor(private readonly rows: RowIndex, private readonly locations: readonly Location[], private readonly activeThinking?: ItemLayout) {
		this.byId = new Map(locations.map((item, index) => [item.id, index + 1]));
		let tool: Location | undefined;
		for (let i = locations.length - 1; i >= 0; i--) if (locations[i]!.tool) { tool = locations[i]; break; }
		if (tool) this.lastTool = { id: tool.id, row: 0 };
	}
	get length(): number { return this.rows.length; }
	get thinkingHeading(): number | undefined {
		const reply = this.activeThinking;
		if (reply?.headingOffset) return this.rows.top(this.byId.get(reply.input.id)!) + reply.headingOffset();
		return undefined;
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
			const offset = entry.options.railOffset ?? 0;
			const node = offset && !entry.header ? <Box marginLeft={offset} flexDirection="column">{entry.node}</Box> : entry.node;
			const rows = this.renderer.rows(node, columns, theme, language);
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
		const entry: Entry = { ...part, header: part.key === "header", options, bytes: 0, length: 0, slice: (start, end) => this.read(entry).slice(start, end) };
		Object.defineProperty(entry, "length", { value: this.read(entry).length });
		return entry;
	}
	prepare(items: readonly TranscriptGroup[], header: ReactNode, headerKey: string, options: LayoutOptions): TranscriptLayout {
		const previous = this.options;
		if ((previous && previous.theme !== options.theme) || (this.items.size > 0 && (!items.length || !this.items.has(items[0]!.id)))) this.clear();
		this.options = options;
		const key = `${options.columns}:${options.railOffset ?? 0}:${options.expanded}:${options.thinkingDisplay}:${options.language}`;
		const variant = this.variants.get(key) ?? { items: new Map<number, ItemLayout>() };
		this.variants.delete(key); this.variants.set(key, variant);
		while (this.variants.size > 4) this.variants.delete(this.variants.keys().next().value!);
		variant.header = this.entry({ key: "header", input: headerKey, node: header }, options, variant.header);
		const headerRows = variant.header;
		const parts: LazyRows[] = [new LazyRows(headerRows.length, () => headerRows)], locations: Location[] = [], nextItems = new Map<number, ItemLayout>();
		for (const item of items) {
			let cached = variant.items.get(item.id);
			const same = cached?.input === item && cached.pending === (options.thinkingId === item.id);
			if (!same) {
				const oldParts = cached?.parts, entries = new Map<string, Entry>();
				cached = { pending: options.thinkingId === item.id, input: item, parts: entries, rows: new LazyRows(cached?.rows.length ?? this.items.get(item.id)?.rows.length ?? 1, () => {
					let lastHeading = -1;
					const index = new RowIndex(this.parts(item, options).map((part, i) => {
						if (part.thinkingHeading) lastHeading = i;
						const old = oldParts?.get(part.key);
						if (old && old.input === part.input) entries.set(part.key, old);
						return new LazyRows(old?.length ?? part.estimate ?? 1, () => {
							const entry = this.entry(part, options, old); entries.set(part.key, entry); return entry;
						});
					}));
					if (lastHeading >= 0) cached!.headingOffset = () => index.top(lastHeading);
					return index;
				}) };
			}
			nextItems.set(item.id, cached!); parts.push(cached!.rows);
			locations.push({ id: item.id, tool: item.kind === "tool" });
		}
		this.items = nextItems; variant.items = nextItems;
		return new TranscriptLayout(new RowIndex(parts), locations, options.thinkingId === undefined ? undefined : nextItems.get(options.thinkingId));
	}
	private parts(item: TranscriptGroup, options: LayoutOptions): Part[] {
		const { expanded, thinkingDisplay } = options;
		const columns = options.columns - (options.railOffset ?? 0);
		if (item.kind !== "assistant") return [{ key: "item", input: item, node: <TranscriptItemView item={item} {...options} columns={columns} /> }];
		const width = frameContentColumns(columns), parts: Part[] = [];
		for (const block of item.blocks) {
			if (!block.text) continue;
			const prefix = String(block.index);
			if (block.kind === "thinking") {
				const pending = item.id === options.thinkingId && block === item.blocks.at(-1);
				const show = expanded || thinkingDisplay;
				parts.push({ key: prefix + ":thinking", input: JSON.stringify([item.durationMs, pending, !!block.text.trim()]), thinkingHeading: true,
					node: <AssistantThinkingMessage text={block.text.trim() ? "x" : " "} expanded={show} durationMs={item.durationMs} pending={pending} columns={width} />, crop: lines => lines.slice(0, 1) });
				if (show && block.text.trim()) {
					const lines = wrapText(block.text, width);
					for (let i = 0; i < lines.length; i += 64) {
						const text = lines.slice(i, i + 64).join("\n");
						parts.push({ key: prefix + ":thinking:" + i, input: text, estimate: Math.min(64, lines.length-i), node: <ThemedText color="muted">{text}</ThemedText> });
					}
				}
				continue;
			}
			const tokens = Lexer.lex(displayText(block.text), { gfm: true }).filter(token => token.type !== "space" && token.type !== "def");
			tokens.forEach((token, index) => {
				if (index) parts.push({ key: prefix + ":gap:" + index, input: "gap", node: <Text> </Text> });
				const key = prefix + ":text:" + index;
				if (token.type !== "code") {
					parts.push({ key, input: JSON.stringify(token), node: <MarkdownTokens tokens={[token]} columns={width} /> });
					return;
				}
				const code = token as Tokens.Code, lines = code.text.split("\n"), language = code.lang?.split(/\s/)[0] || "text";
				const highlighted = highlightCode(code.text, language), gutterWidth = String(lines.length).length;
				for (let i = 0; i < lines.length; i += 64) {
					const text = lines.slice(i, i + 64).join("\n"), highlightedLines = highlighted.slice(i, i + 64);
					parts.push({ key: key + ":" + i, input: JSON.stringify([language,gutterWidth,highlightedLines]), estimate: highlightedLines.length + Number(i === 0),
						node: <HighlightedCode code={text} highlightedLines={highlightedLines} language={language} columns={width} startLine={i + 1} gutterWidth={gutterWidth} showLanguage={i === 0} /> });
				}
			});
		}
		// One leading junction for the entire turn. Segment and wrap without duplicating it.
		const framed = parts.map((part, i) => ({ ...part, key: (i === 0 ? "first:" : "body:") + part.key,
			node: <MessageFrame columns={columns} marker="∇" first={i === 0} gap={false}>{part.node}</MessageFrame> }));
		return [...framed, { key: "space", input: "space", node: <MessageFrame columns={columns} first={false} gap={false}><Text> </Text></MessageFrame> }];
	}
	private clear(): void {
		for (const entry of this.lru.keys()) entry.rows = undefined;
		this.items.clear(); this.variants.clear(); this.lru.clear(); this.bytes = 0;
	}
	dispose(): void { this.renderer.dispose(); this.clear(); }
}
