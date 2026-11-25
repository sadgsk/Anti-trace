import { readFileSync } from "node:fs";
import { GifReader } from "omggif";
import { lastLogoFrame, sampleLogoFrame } from "./entrance-vector.ts";

export { lastLogoFrame, sampleLogoFrame };

/** The GIF stores delta rectangles. Composite them before extracting its monochrome ink coverage. */
function loadReplyAnimation() {
	const gif = new GifReader(readFileSync(new URL("../../../assets/residualx-reply-loop.gif", import.meta.url)));
	const pixels = new Uint8Array(gif.width * gif.height * 4);
	const frames: Uint8Array[] = [];
	for (let frame = 0; frame < gif.numFrames(); frame++) {
		gif.decodeAndBlitFrameRGBA(frame, pixels);
		const matte = pixels[0]!; // The animation has a uniform matte at the top-left pixel.
		const alpha = new Uint8Array(gif.width * gif.height);
		for (let i = 0; i < alpha.length; i++) alpha[i] = Math.round(255 * (pixels[i * 4]! - matte) / (255 - matte));
		frames.push(alpha);
	}
	return { frames, width: gif.width, height: gif.height };
}
type Animation = ReturnType<typeof loadReplyAnimation>;
let reply: Animation | undefined;
export const replyAnimation = () => reply ??= loadReplyAnimation();

/** Average the area covered by each terminal pixel to retain thin, antialiased edges. */
export function sampleFrame(animation: Animation, frame: number, w: number, h: number, levels: number, topRow = 0, bottomRow = animation.height): Uint8Array {
	const { frames, width, height } = animation;
	const source = frames[frame]!, result = new Uint8Array(w * h);
	const sx = width / w, sy = (bottomRow - topRow) / h;
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			const left = x * sx, right = (x + 1) * sx, top = topRow + y * sy, bottom = topRow + (y + 1) * sy;
			let sum = 0;
			for (let iy = Math.floor(top); iy < Math.min(height, Math.ceil(bottom)); iy++) {
				const overlapY = Math.min(bottom, iy + 1) - Math.max(top, iy);
				for (let ix = Math.floor(left); ix < Math.min(width, Math.ceil(right)); ix++) {
					const overlapX = Math.min(right, ix + 1) - Math.max(left, ix);
					sum += source[iy * width + ix]! * overlapX * overlapY;
				}
			}
			result[y * w + x] = Math.round(sum * levels / (255 * sx * sy));
		}
	}
	return result;
}


export const logoWidth = (columns: number) => Math.min(columns, columns >= 90 ? 54 : columns >= 56 ? 42 : 30);
export const logoHeight = (columns: number) => Math.round(logoWidth(columns) / 7.5);
export const entranceGlyph = 0xe700;
export const logoFrameAt = (elapsed: number) => Math.min(lastLogoFrame, Math.max(0, 1 + Math.floor((elapsed - 180) / 30)));
export const hasLargeLogo = (columns: number, rows: number) => columns >= 32 && rows >= 14;

const textFrames = new Map<string, string[]>();
/** Text terminals sample the identical poses on their 2×4 subcell grid. */
export function logoLines(frame: number, columns: number): string[] {
	const logoColumns = logoWidth(columns), logoRows = logoHeight(columns), key = logoColumns + ":" + frame;
	const old = textFrames.get(key);
	if (old) return old;
	const w = logoColumns * 2, h = logoRows * 4;
	const samples = sampleLogoFrame(frame, w, h, 255);
	const bits = [1, 8, 2, 16, 4, 32, 64, 128];
	const rows = Array.from({ length: logoRows }, (_, y) => {
		let line = "";
		for (let x = 0; x < logoColumns; x++) {
			let mask = 0;
			for (let dot = 0; dot < 8; dot++) {
				if (samples[(y * 4 + (dot >> 1)) * w + x * 2 + (dot % 2)]! >= 32) mask |= bits[dot]!;
			}
			line += mask ? String.fromCharCode(0x2800 + mask) : " ";
		}
		return line;
	});
	textFrames.set(key, rows);
	return rows;
}
