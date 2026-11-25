/** Timing and glyph slots for the 60 frames in assets/residualx-reply-loop.gif. */
export const replyFrames = 60;
export const replyFrameMs = 50;
export const replyGlyphBase = 0xe600;

export function replyFrameAt(elapsed: number): number {
	return Math.floor(Math.max(0, elapsed) / replyFrameMs) % replyFrames;
}
