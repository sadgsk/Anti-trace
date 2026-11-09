import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Box, Text } from "ink";
import type { TranscriptAnchor, ViewportMetrics } from "../viewport-state.ts";
import type { TranscriptGroup } from "../messages/TranscriptView.tsx";
import { ThemedText, useTheme } from "../theme/ThemeProvider.tsx";
import { useLocale } from "../locale/LocaleProvider.tsx";
import { TranscriptLayoutCache, type TranscriptLayout } from "./TranscriptLayoutCache.tsx";
import type { TerminalRows } from "./terminal-rows.ts";

export interface TranscriptFrame { rows: TerminalRows; viewportRows: number; columns: number; native: boolean; historyVersion: number; onWrite(): void }
interface View { lines: string[]; animated: number[]; layout: TranscriptLayout; request: object }

function VisibleRows({ lines, animated }: Pick<View, "lines" | "animated">) {
	const [frame, setFrame] = useState(0), active = animated.length > 0;
	useEffect(() => { if (!active) return; const timer = setInterval(() => setFrame(value => (value + 1) % 4), 160); return () => clearInterval(timer); }, [active]);
	// Truncate each cached row independently and reserve a line even for empty rows.
	return lines.map((line, row) => {
		const dot = animated.includes(row) ? line.indexOf("●") : -1;
		return <Box key={row} height={1} flexShrink={0} flexDirection="column">
			<Text wrap="truncate-end">{dot < 0 ? line : <>
				{line.slice(0, dot)}
				<ThemedText color={frame < 2 ? "accent" : "dim"}>●</ThemedText>
				{line.slice(dot + 1)}
			</>}</Text>
		</Box>;
	});
}

/** Only visible terminal rows enter the live Ink tree. Cache misses run outside React commits. */
export function TranscriptViewport({ items, header, headerKey, height, columns, scrollOffset, native = false, reviewing = false, requestedAnchor,
	expanded, thinkingDisplay, historyVersion = 0, onMetrics, onFrame, cache: sharedCache }: {
	items: readonly TranscriptGroup[]; header: ReactNode; headerKey: string; height: number; columns: number; scrollOffset: number;
	native?: boolean; reviewing?: boolean; requestedAnchor?: TranscriptAnchor; expanded: boolean; thinkingDisplay: boolean;
	historyVersion?: number; onMetrics: (metrics: ViewportMetrics) => void; onFrame?: (frame?: TranscriptFrame) => void; cache?: TranscriptLayoutCache;
}) {
	const theme = useTheme(), { language } = useLocale();
	const cache = useRef<TranscriptLayoutCache | undefined>(undefined);
	const prepared = useRef<{ items: readonly TranscriptGroup[]; headerKey: string; columns: number; expanded: boolean; thinkingDisplay: boolean; theme: typeof theme; language: typeof language; layout: TranscriptLayout } | undefined>(undefined);
	const held = useRef<{ anchor?: TranscriptAnchor; top: number; offset: number }>({ top: 0, offset: 0 });
	const [view, setView] = useState<View>();
	const request = useRef<object>({});
	useLayoutEffect(() => {
		const current = {}; request.current = current;
		onFrame?.(undefined);
		const job = setImmediate(() => {
			const old = prepared.current;
			const same = old && old.items === items && old.headerKey === headerKey && old.columns === columns && old.expanded === expanded
				&& old.thinkingDisplay === thinkingDisplay && old.theme === theme && old.language === language;
			const layout = same ? old.layout : (sharedCache ?? (cache.current ??= new TranscriptLayoutCache())).prepare(items, header, headerKey, { columns, expanded, thinkingDisplay, theme, language });
			prepared.current = { items, headerKey, columns, expanded, thinkingDisplay, theme, language, layout };
			const previous = held.current;
			const scrolling = previous.offset !== scrollOffset;
			const target = requestedAnchor ?? (scrolling ? layout.anchor(Math.max(0, layout.length - height - scrollOffset)) : previous.anchor);
			if (reviewing || scrollOffset > 0 || requestedAnchor) layout.ensureAnchor(target, height + 16);
			else layout.ensureTail(height + 16);
			const limit = Math.max(0, layout.length - height);
			let top = limit;
			if (requestedAnchor) top = layout.resolve(requestedAnchor) ?? previous.top;
			else if (scrolling && (reviewing || scrollOffset > 0)) top = layout.resolve(target) ?? limit - scrollOffset;
			else if (reviewing || scrollOffset > 0) top = layout.resolve(previous.anchor) ?? previous.top;
			top = Math.max(0, Math.min(limit, top));
			const offset = limit - top, anchor = layout.anchor(top);
			const start = Math.max(0, top - 8), rows = layout.slice(start, top + height + 8);
			held.current = { anchor, top, offset: reviewing ? offset : scrollOffset };
			setView({ layout, animated: layout.animatedRows(top, height), lines: rows.slice(top - start, top - start + height), request: current });
			onMetrics({ limit, offset, anchor, lastTool: layout.lastTool, requestedOffset: scrollOffset });
		});
		return () => clearImmediate(job);
	}, [items, headerKey, height, columns, scrollOffset, native, reviewing, requestedAnchor, expanded, thinkingDisplay, historyVersion, theme, language, onMetrics, onFrame, sharedCache]);
	useLayoutEffect(() => {
		if (view?.request === request.current) onFrame?.({ rows: view.layout, viewportRows: height, columns, native, historyVersion,
			onWrite: () => { if (native) { const limit = Math.max(0, view.layout.length - height); onMetrics({ limit, offset: 0, anchor: view.layout.anchor(limit), lastTool: view.layout.lastTool }); } } });
	}, [view, height, columns, native, historyVersion, onFrame]);
	useEffect(() => () => { const old = cache.current; cache.current = undefined; if (old) setImmediate(() => old.dispose()); }, []);
	return <Box height={height} width={columns} flexShrink={0} overflow="hidden" flexDirection="column">
		{view?.lines.length ? <VisibleRows lines={view.lines} animated={view.animated} /> : null}
	</Box>;
}
