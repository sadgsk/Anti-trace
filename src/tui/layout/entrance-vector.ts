import { readFileSync } from "node:fs";

interface EntranceArt {
	width: number;
	height: number;
	/** Each frame is the unioned ink outline from the master, including the holes in the letters. */
	frames: number[][][];
}

let art: EntranceArt | undefined;
export const lastLogoFrame = 113;

/** Integrate horizontal ink spans at the requested resolution, including fractional edge pixels. */
export function sampleLogoFrame(frame: number, width: number, height: number, levels: number): Uint8Array {
	art ??= JSON.parse(readFileSync(new URL("../../../assets/residualx-entrance-paths.json", import.meta.url), "utf8")) as EntranceArt;
	const t = Math.max(0, Math.min(1, (frame - 78) / (lastLogoFrame - 78)));
	const settled = t * t * (3 - 2 * t);
	const top = Math.round(6 * settled), bottom = art.height - Math.round(28 * settled);
	const scale = Math.min(width / art.width, height / (bottom - top));
	const w = Math.max(1, Math.round(art.width * scale)), h = Math.max(1, Math.round((bottom - top) * scale));
	const left = Math.round((width - w) * (1 - settled) / 2);
	const head = Math.round((height - h) * (1 + settled) / 2);
	const scaleX = w / art.width, scaleY = h / (bottom - top);
	const edges: { low: number; high: number; x: number; slope: number }[] = [];
	for (const ring of art.frames[frame]!) {
		for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
			const a = ring[j + 1]! < ring[i + 1]! ? j : i;
			const b = a === j ? i : j;
			const low = head + (ring[a + 1]! - top) * scaleY;
			const high = head + (ring[b + 1]! - top) * scaleY;
			if (low === high) continue;
			edges.push({ low, high, x: left + ring[a]! * scaleX, slope: (ring[b]! - ring[a]!) * scaleX / (high - low) });
		}
	}

	const pixels = new Uint8Array(width * height);
	const coverage = new Float64Array(width);
	const hits: number[] = [];
	const subRows = 16;
	const gain = 1.8 - 0.8 * settled;
	for (let y = head; y < head + h; y++) {
		coverage.fill(0);
		for (let sub = 0; sub < subRows; sub++) {
			const scan = y + (sub + 0.5) / subRows;
			hits.length = 0;
			for (const edge of edges) {
				if (scan >= edge.low && scan < edge.high) hits.push(edge.x + (scan - edge.low) * edge.slope);
			}
			hits.sort((a, b) => a - b);
			for (let i = 0; i + 1 < hits.length; i += 2) {
				const start = Math.max(left, hits[i]!), end = Math.min(left + w, hits[i + 1]!);
				for (let x = Math.floor(start); x < end; x++) {
					coverage[x]! += Math.min(end, x + 1) - Math.max(start, x);
				}
			}
		}
		for (let x = left; x < left + w; x++) {
			if (!coverage[x]) continue;
			const alpha = Math.min(1, coverage[x]! / subRows);
			pixels[y * width + x] = Math.round(levels * (gain === 1 ? alpha : 1 - (1 - alpha) ** gain));
		}
	}
	return pixels;
}
