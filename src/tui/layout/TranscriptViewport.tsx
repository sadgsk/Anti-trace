import { useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Box, Text } from "ink";
import type { TranscriptAnchor, ViewportMetrics } from "../viewport-state.ts";
import type { TranscriptGroup } from "../messages/TranscriptView.tsx";
import { useTheme } from "../theme/ThemeProvider.tsx";
import { useLocale } from "../locale/LocaleProvider.tsx";
import { TranscriptLayoutCache, type TranscriptLayout } from "./TranscriptLayoutCache.tsx";
import type { TerminalRows } from "./terminal-rows.ts";
import { lastLogoFrame, logoFrameAt, logoHeight } from "./brand-art.ts";
import { WelcomeRow } from "./WelcomeHeader.tsx";
import { ReplyGraphicsContext, ThinkingIndicator } from "../messages/ReplyMark.tsx";

export interface TranscriptFrame { rows: TerminalRows; modal: boolean; logoOffset?: number; brandColumns: number; viewportRows: number; columns: number; native: boolean; historyVersion: number; thinkingRow?: number; onWrite(): void }
interface View { top: number; lines: string[]; thinkingTop?: number; layout: TranscriptLayout; request: object }

function VisibleRows({ lines, thinkingTop, startedAt, logoOffset, openedAt, columns, brandColumns, cwd }: Pick<View, "lines" | "thinkingTop"> & { startedAt: number; logoOffset?: number; openedAt: number; columns: number; brandColumns: number; cwd: string }) {
	const graphic = useContext(ReplyGraphicsContext);
	const [logoFrame, setLogoFrame] = useState(() => logoFrameAt(Date.now() - openedAt));
	useEffect(() => {
		if (logoOffset === undefined || !openedAt) return;
		let timer: NodeJS.Timeout;
		const tick = () => {
			const elapsed = Date.now() - openedAt, frame = logoFrameAt(elapsed);
			setLogoFrame(frame);
			if (frame < lastLogoFrame) timer = setTimeout(tick, Math.max(1, 180 + frame * 30 - elapsed));
		};
		tick();
		return () => clearTimeout(timer);
	}, [logoOffset, openedAt]);
	// Truncate each cached row independently and reserve a line even for empty rows.
	return lines.map((line, row) => {
		if (logoOffset !== undefined && logoOffset + row < logoHeight(brandColumns)) {
			const band = logoOffset + row, frame = openedAt ? logoFrame : lastLogoFrame;
			return <WelcomeRow key={row} band={band} frame={frame} graphic={graphic} columns={columns} brandColumns={brandColumns} cwd={cwd} />;
		}
		return <Box key={row} height={1} flexShrink={0}>{row === thinkingTop
			? <ThinkingIndicator line={line} startedAt={startedAt} columns={columns} />
			: <Text wrap="truncate-end">{line}</Text>}</Box>;
	});
}

/** Only visible terminal rows enter the live Ink tree. Cache misses run outside React commits. */
export function TranscriptViewport({ items, header, headerKey, height, columns, screenColumns = columns, brandColumns = columns, cwd = "", railOffset = 0, largeLogo = false, openedAt = 0, modal = false, scrollOffset, native = false, reviewing = false, requestedAnchor, thinkingId, startedAt = 0,
	expanded, thinkingDisplay, historyVersion = 0, onMetrics, onFrame, cache: sharedCache }: {
	items: readonly TranscriptGroup[]; header: ReactNode; headerKey: string; height: number; columns: number; screenColumns?: number; brandColumns?: number; cwd?: string; railOffset?: number; modal?: boolean; largeLogo?: boolean; openedAt?: number; scrollOffset: number;
	native?: boolean; reviewing?: boolean; requestedAnchor?: TranscriptAnchor; expanded: boolean; thinkingDisplay: boolean;
	thinkingId?: number; startedAt?: number;
	historyVersion?: number; onMetrics: (metrics: ViewportMetrics) => void; onFrame?: (frame?: TranscriptFrame) => void; cache?: TranscriptLayoutCache;
}) {
	const theme = useTheme(), { language } = useLocale();
	const cache = useRef<TranscriptLayoutCache | undefined>(undefined);
	const prepared = useRef<{ items: readonly TranscriptGroup[]; headerKey: string; columns: number; railOffset: number; expanded: boolean; thinkingDisplay: boolean; thinkingId?: number; theme: typeof theme; language: typeof language; layout: TranscriptLayout } | undefined>(undefined);
	const held = useRef<{ anchor?: TranscriptAnchor; top: number; offset: number }>({ top: 0, offset: 0 });
	const [view, setView] = useState<View>();
	const request = useRef<object>({});
	useLayoutEffect(() => {
		const current = {}; request.current = current;
		onFrame?.(undefined);
		const job = setImmediate(() => {
			const old = prepared.current;
			const same = old && old.items === items && old.headerKey === headerKey && old.columns === columns && old.railOffset === railOffset && old.expanded === expanded
				&& old.thinkingDisplay === thinkingDisplay && old.thinkingId === thinkingId && old.theme === theme && old.language === language;
			const layout = same ? old.layout : (sharedCache ?? (cache.current ??= new TranscriptLayoutCache())).prepare(items, header, headerKey, { columns, railOffset, expanded, thinkingDisplay, theme, language, thinkingId });
			prepared.current = { items, headerKey, columns, railOffset, expanded, thinkingDisplay, thinkingId, theme, language, layout };
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
			const heading = layout.thinkingHeading;
			const thinkingTop = heading === undefined ? undefined : heading - top;
			setView({ top, layout, lines: rows.slice(top - start, top - start + height), request: current,
				thinkingTop: thinkingTop !== undefined && thinkingTop >= 0 && thinkingTop < height ? thinkingTop : undefined });
			onMetrics({ limit, offset, anchor, lastTool: layout.lastTool, requestedOffset: scrollOffset });
		});
		return () => clearImmediate(job);
	}, [items, headerKey, height, columns, railOffset, scrollOffset, native, reviewing, requestedAnchor, expanded, thinkingDisplay, thinkingId, historyVersion, theme, language, onMetrics, onFrame, sharedCache]);
	const logoOffset = view && largeLogo && view.top < logoHeight(brandColumns) ? view.top : undefined;
	useLayoutEffect(() => {
		if (view?.request === request.current) onFrame?.({ rows: view.layout, viewportRows: Math.min(height, view.lines.length), brandColumns, columns: screenColumns, modal, logoOffset, native, historyVersion, thinkingRow: thinkingId === undefined ? undefined : view.thinkingTop,
			onWrite: () => { if (native) { const limit = Math.max(0, view.layout.length - height); onMetrics({ limit, offset: 0, anchor: view.layout.anchor(limit), lastTool: view.layout.lastTool }); } } });
	}, [view, height, screenColumns, modal, logoOffset, native, historyVersion, thinkingId, brandColumns, onFrame]);
	useEffect(() => () => { const old = cache.current; cache.current = undefined; if (old) setImmediate(() => old.dispose()); }, []);
	return <Box height={Math.min(height, view?.lines.length ?? 0)} width={columns} flexShrink={0} overflow="hidden" flexDirection="column">
		{view?.lines.length ? <VisibleRows openedAt={openedAt} logoOffset={logoOffset} lines={view.lines} columns={columns} brandColumns={brandColumns} cwd={cwd} thinkingTop={thinkingId === undefined ? undefined : view.thinkingTop} startedAt={startedAt} /> : null}
	</Box>;
}
