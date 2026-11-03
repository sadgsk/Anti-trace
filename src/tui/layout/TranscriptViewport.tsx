import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Box, measureElement, type DOMElement } from "ink";
import type { TranscriptAnchor, ViewportMetrics } from "../viewport-state.ts";
export type TranscriptElements = Map<number, { element: DOMElement; tool: boolean }>;
/** Scroll measured content; never shrink text inside a bottom-aligned fixed box. */
export function TranscriptViewport({ children, height, columns, scrollOffset, natural = false, reviewing = false, requestedAnchor, elements, onScrollLimit, onMetrics }: {
	children: ReactNode; height: number; columns: number; scrollOffset: number; natural?: boolean; reviewing?: boolean; requestedAnchor?: TranscriptAnchor;
	elements?: TranscriptElements; onScrollLimit?: (limit: number) => void; onMetrics?: (metrics: ViewportMetrics) => void;
}) {
	const ref = useRef<DOMElement>(null), [top, setTop] = useState(0);
	const held = useRef<TranscriptAnchor | undefined>(undefined), previousOffset = useRef(0), previousTop = useRef(0);
	useLayoutEffect(() => {
		if (!ref.current) return;
		const measured = measureElement(ref.current).height, limit = Math.max(0, measured - height);
		const locations = [...(elements ?? [])].map(([id, entry]) => ({ id, tool: entry.tool,
			top: entry.element.yogaNode?.getComputedTop() ?? 0, height: measureElement(entry.element).height })).sort((a,b) => a.top - b.top);
		const resolve = (anchor?: TranscriptAnchor) => { const item = anchor && locations.find(item => item.id === anchor.id); return item && anchor ? item.top + Math.min(anchor.row, Math.max(0, item.height - 1)) : undefined; };
		let next = limit;
		if (natural) next = 0;
		else if (requestedAnchor) next = resolve(requestedAnchor) ?? previousTop.current;
		else if (previousOffset.current !== scrollOffset) next = limit - scrollOffset;
		else if (reviewing || scrollOffset > 0) next = resolve(held.current) ?? previousTop.current;
		next = Math.max(0, Math.min(limit, next));
		const first = locations.find(item => item.top + item.height > next), lastTool = locations.filter(item => item.tool).at(-1);
		// Above the first message (welcome header) or in a gap the row is negative; clamping it to 0 would snap back to the message.
		const anchor = first ? { id: first.id, row: next - first.top } : undefined;
		held.current = anchor; previousTop.current = next;
		const offset = natural ? 0 : Math.max(0, limit - next);
		previousOffset.current = onMetrics && reviewing ? offset : scrollOffset;
		setTop(current => current === next ? current : next);
		onScrollLimit?.(limit);
		onMetrics?.({ limit, offset, anchor, lastTool: lastTool ? { id: lastTool.id, row: 0 } : undefined });
	});
	return <Box height={natural ? undefined : height} width={columns} flexShrink={0} overflow={natural ? undefined : "hidden"} flexDirection="column">
		<Box ref={ref} width={columns} flexDirection="column" flexShrink={0} marginTop={natural ? 0 : -top}>{children}</Box>
	</Box>;
}
