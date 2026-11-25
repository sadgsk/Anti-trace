import assert from "node:assert/strict";
import test from "node:test";
import { ReplyGraphics } from "../../src/cli/ink/reply-graphics.ts";
import { entranceGlyph, lastLogoFrame, logoHeight, logoLines, logoWidth, sampleLogoFrame } from "../../src/tui/layout/brand-art.ts";

test("settled logo resolves the top stroke of the R at native pixel density", () => {
	for (const [width, height] of [[486, 133], [648, 168]] as const) {
		const pixels = sampleLogoFrame(lastLogoFrame, width, height, 16);
		const x = Math.floor(width * 0.16);
		const crossing = Array.from({ length: Math.floor(height / 4) }, (_, y) => pixels[y * width + x]!);
		assert.ok(crossing.filter(ink => ink === 16).length >= 2, "solid ink inside the stroke");
		const partial = crossing.filter(ink => ink > 0 && ink < 16);
		assert.ok(partial.length > 0 && partial.length <= 2, "at most one antialiased pixel on each edge");
	}
});

test("the text fallback fits every entrance pose into the reserved logo rows", () => {
	const columns = 60;
	for (let frame = 0; frame <= lastLogoFrame; frame++) {
		const lines = logoLines(frame, columns);
		assert.equal(lines.length, logoHeight(columns));
		assert.ok(lines.every(line => line.length === logoWidth(columns)));
		assert.ok(lines.some(line => line.trim().length > 0));
	}
});

test("SIXEL logo bands follow the measured cell size across a terminal zoom", () => {
	const graphics = new ReplyGraphics();
	graphics.response("\x1b[?65;4;22c");
	const row = String.fromCharCode(entranceGlyph + lastLogoFrame).padEnd(54);
	for (const [width, height] of [[9, 19], [36, 72]] as const) {
		graphics.resize();
		graphics.response(`\x1b[6;${height};${width}t`);
		for (let band = 0; band < logoHeight(120); band++) {
			assert.ok(graphics.paintLogo(row, band, 120).includes(`"1;1;${54 * width};${height}`));
		}
	}
});
