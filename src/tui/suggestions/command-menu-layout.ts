import stringWidth from "string-width";
import type { SlashCommandDefinition } from "../../cli/commands/command-registry.ts";
import type { PromptSuggestionsSnapshot } from "./prompt-suggestions-controller.ts";

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Cut only between graphemes; Chinese text consumes two terminal columns. */
export function truncateMenuText(text: string, columns: number): string {
	if (columns <= 0) return "";
	if (stringWidth(text) <= columns) return text;
	let result = "";
	let width = 0;
	for (const { segment } of graphemes.segment(text)) {
		const size = stringWidth(segment);
		if (width + size > columns - 1) break;
		result += segment;
		width += size;
	}
	return `${result}…`;
}

export interface CommandMenuLayout {
	readonly width: number;
	readonly marginLeft: number;
	readonly framed: boolean;
	readonly contentWidth: number;
	readonly start: number;
	readonly count: number;
	readonly more: string;
	readonly footer: boolean;
}

/** The row budget includes margin, borders, separator, overflow hint and footer. */
export function layoutCommandMenu(state: PromptSuggestionsSnapshot, columns: number, rows: number): CommandMenuLayout | null {
	const height = Math.max(0, Math.floor(rows));
	const availableWidth = Math.max(0, Math.floor(columns));
	if (!state.open || height === 0 || availableWidth === 0) return null;
	const framed = availableWidth >= 40 && height >= 7;
	const marginLeft = framed ? 2 : 0;
	const width = Math.min(100, availableWidth - marginLeft);
	const contentWidth = width - (framed ? 4 : 0);
	const footer = height >= 2;
	// Framed chrome: top margin + two borders + footer separator.
	let capacity = height - (framed ? 4 : 0) - Number(footer);
	const showMore = framed && state.items.length > Math.min(6, capacity) && capacity >= 2;
	if (showMore) capacity--;
	const count = Math.min(state.items.length, 6, capacity);
	const start = Math.max(0, Math.min(state.selectedIndex - Math.floor(count / 2), state.items.length - count));
	const below = state.items.length - start - count;
	const more = showMore ? truncateMenuText(start === 0 ? `… 还有 ${below} 条`
		: `… 上方 ${start} 条 · 下方 ${below} 条`, contentWidth) : "";
	return { width, marginLeft, framed, contentWidth, start, count, more, footer };
}

/** Menu rows show the command name and description; parameter syntax belongs in help. */
export function layoutCommandMenuRow(command: SlashCommandDefinition, columns: number, prefix = "/") {
	const fullName = `${prefix}${command.name}`;
	const descriptionWidth = columns - stringWidth(fullName) - 2;
	const description = descriptionWidth >= 8 ? truncateMenuText(command.description, descriptionWidth) : "";
	const labelWidth = columns - (description ? stringWidth(description) + 2 : 0);
	const name = truncateMenuText(fullName, labelWidth);
	const gap = " ".repeat(Math.max(0, columns - stringWidth(name + description)));
	return { name, description, gap };
}

export interface MenuShortcut { readonly shortcut: string; readonly action: string }
export function layoutCommandMenuFooter(columns: number, selectedIndex: number, total: number, file = false, t: (text: string) => string = text => text) {
	const counter = truncateMenuText(`${total === 0 ? 0 : selectedIndex + 1}/${total}`, columns);
	const source: readonly MenuShortcut[] = total === 0 ? [{ shortcut: "Esc", action: "收起" }] : [
		{ shortcut: "↑↓", action: "选择" }, { shortcut: "Enter", action: file ? "补入" : "确认" },
		{ shortcut: "Tab", action: "补全" }, { shortcut: "Esc", action: "收起" },
	];
	const all = source.map(item => ({ ...item, action: t(item.action) }));
	const primary = all.filter(item => item.shortcut === (total === 0 ? "Esc" : "Enter"));
	const label = (items: readonly MenuShortcut[]) => items.map(item => `${item.shortcut} ${item.action}`).join("  ");
	const shortcuts = [all, all.filter(item => item.shortcut !== "Tab"), primary]
		.find(items => stringWidth(label(items)) + 2 + stringWidth(counter) <= columns) ?? [];
	const gap = " ".repeat(Math.max(0, columns - stringWidth(label(shortcuts) + counter)));
	return { shortcuts, counter, gap };
}
