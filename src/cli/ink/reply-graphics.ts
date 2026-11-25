import { stripVTControlCharacters } from "node:util";
import stringWidth from "string-width";
import { replyAnimation, sampleFrame, sampleLogoFrame, entranceGlyph, logoHeight, logoWidth, lastLogoFrame } from "../../tui/layout/brand-art.ts";
import { replyFrames, replyGlyphBase } from "../../tui/messages/reply-animation.ts";
import { vectorInk, type RGB } from "../../tui/theme/color.ts";
const levels = 16;
export const replyGraphicsQuery = "\x1b[c\x1b[16t\x1b]10;?\x1b\\\x1b]11;?\x1b\\";
const frameToken = new RegExp(`^((?:\\x1b\\[[\\d;]*m| )*[∇│](?:\\x1b\\[[\\d;]*m)*─)([${String.fromCharCode(replyGlyphBase)}-${String.fromCharCode(replyGlyphBase + replyFrames - 1)}])`, "u");
const nablaBranch = /^((?:\x1b\[[\d;]*m| )*)∇(?=(?:\x1b\[[\d;]*m)*─)/u;

/** Sample a one-cell junction about the same centerlines as the terminal's │ and ─. */
function nablaCoverage(width: number, height: number): Uint8Array {
	const radius = Math.min(width * 0.42, height * 0.28), halfHeight = radius * Math.sqrt(3) / 2;
	const stroke = Math.max(1, Math.min(width, height) / 8);
	const rise = 2 * halfHeight, sideLengthSquared = radius ** 2 + rise ** 2;
	return Uint8Array.from({ length: width * height }, (_, i) => {
		const x = i % width + 0.5 - width / 2, y = Math.floor(i / width) + 0.5 - height / 2;
		// Mirror the two slopes and find the closest point between tip and top corner.
		const horizontal = Math.abs(x);
		const top = Math.hypot(Math.max(0, horizontal - radius), y + halfHeight);
		const alongSide = Math.max(0, Math.min(1, (horizontal * radius + (halfHeight - y) * rise) / sideLengthSquared));
		const side = Math.hypot(horizontal - alongSide * radius, y - halfHeight + alongSide * rise);
		const branch = Math.hypot(Math.max(0, radius / 2 - x), y);
		return Math.round(levels * Math.max(0, Math.min(1, 0.5 + stroke / 2 - Math.min(top, side, branch))));
	});
}

/** A transparent SIXEL tile, sampled at the terminal's own image resolution. */
function encodeTile(coverage: Uint8Array, width: number, height: number, ink: RGB, paper: RGB): string {
	let data = `\x1bP0;1q"1;1;${width};${height}`;
	for (let level = 1; level <= levels; level++) {
		const rgb = ink.map((end, i) => Math.round((paper[i]! + (end - paper[i]!) * level / levels) * 100 / 255));
		data += `#${level};2;${rgb.join(";")}`;
	}
	for (let y = 0; y < height; y += 6) {
		const bands = Array.from({ length: levels + 1 }, () => new Uint8Array(width));
		for (let x = 0; x < width; x++) {
			for (let bit = 0; bit < 6 && y + bit < height; bit++) {
				const level = coverage[(y + bit) * width + x]!;
				if (level) bands[level]![x] |= 1 << bit;
			}
		}
		if (y) data += "-";
		for (let level = 1; level <= levels; level++) {
			const band = bands[level]!;
			let end = width;
			while (end && !band[end - 1]) end--;
			if (!end) continue;
			const pixels = String.fromCharCode(...band.subarray(0, end).map(mask => 63 + mask));
			data += `$#${level}` + pixels.replace(/(.)\1{3,}/g, run => `!${run.length}${run[0]}`);
		}
	}
	return data + "\x1b\\";
}

export class ReplyGraphics {
	private sixel = false;
	private size = 0;
	private cellWidth = 0;
	private cellHeight = 0;
	private logoTiles = new Map<string, string[]>();
	private ink: RGB = [242, 242, 242];
	background?: RGB;
	private readonly frames = new Map<number, string>();
	private nablaTile?: string;
	get available(): boolean { return this.sixel && this.size >= 8 && this.cellWidth <= 128 && this.cellHeight <= 256; }
	resize(): boolean {
		this.size = 0;
		this.nablaTile = undefined;
		this.frames.clear(); this.logoTiles.clear();
		return this.sixel;
	}

	response(raw: string): void {
		const attributes = /^\x1b\[\?([\d;]+)c$/.exec(raw);
		if (attributes) this.sixel = attributes[1]!.split(";").slice(1).includes("4");
		const cells = /^\x1b\[6;(\d{1,5});(\d{1,5})t$/.exec(raw);
		if (cells) {
			this.cellHeight = Number(cells[1]); this.cellWidth = Number(cells[2]);
			this.size = Math.min(64, this.cellHeight, this.cellWidth * 2);
			this.nablaTile = undefined;
			this.frames.clear(); this.logoTiles.clear();
		}
		const color = /^\x1b\](10|11);rgb:([0-9a-f]{1,4})\/([0-9a-f]{1,4})\/([0-9a-f]{1,4})(?:\x07|\x1b\\)$/i.exec(raw);
		if (color) {
			const channels = color.slice(2).map(hex => Math.round(parseInt(hex, 16) * 255 / (16 ** hex.length - 1))) as [number, number, number];
			if (color[1] === "11") {
				if (this.background?.every((value, i) => value === channels[i])) return;
				this.background = channels;
			} else this.ink = channels;
			this.nablaTile = undefined;
			this.frames.clear(); this.logoTiles.clear();
		}
	}

	/** Draw each logo band on its own text row so scrolling, clipping and side menus remain native. */
	paintLogo(row: string, band: number, columns: number): string {
		const logoRows = logoHeight(columns), logoColumns = logoWidth(columns);
		const frame = row.charCodeAt(0) - entranceGlyph;
		if (band < 0 || band >= logoRows || frame < 0 || frame > lastLogoFrame || !Number.isFinite(frame)) return row;
		const blank = " ".repeat(logoColumns) + row.slice(logoColumns);
		if (!this.available) return blank;
		const key = logoColumns + ":" + frame;
		let tiles = this.logoTiles.get(key);
		if (!tiles) {
			const height = this.cellHeight * logoRows;
			const width = this.cellWidth * logoColumns;
			const pixels = sampleLogoFrame(frame, width, height, levels);
			const bandH = height / logoRows, stride = bandH * width;
			tiles = Array.from({ length: logoRows }, (_, i) => encodeTile(pixels.subarray(i * stride, (i + 1) * stride), width, bandH,
				this.background ? vectorInk(this.background) : this.ink, this.background ?? [20, 20, 22]));
			if (this.logoTiles.size > 3) this.logoTiles.clear();
			this.logoTiles.set(key, tiles);
		}
		return blank + "\x1b7\x1b[1G" + tiles[band] + "\x1b8";
	}

	paintJunction(row: string, railColumn: number): string {
		if (!this.available) return row;
		const match = nablaBranch.exec(row);
		if (!match || stripVTControlCharacters(match[1]!).length !== railColumn) return row;
		this.nablaTile ??= encodeTile(nablaCoverage(this.cellWidth, this.cellHeight), this.cellWidth, this.cellHeight,
			this.background ? vectorInk(this.background) : this.ink, this.background ?? [20, 20, 22]);
		// Clear the font glyph before painting. A concealed ∇ can still bleed into the next cell.
		return row.replace(nablaBranch, "$1 ") + `\x1b7\x1b[${railColumn + 1}G${this.nablaTile}\x1b8`;
	}

	/** Decorate only a known UI slot. Writing its blank cells first erases the preceding image. */
	paint(row: string): string {
		const token = frameToken.exec(row);
		if (!token) return row;
		const frame = token[2]!.charCodeAt(0) - replyGlyphBase;
		if (!this.available) return row.replace(frameToken, "$1 ");
		let tile = this.frames.get(frame);
		if (!tile) { tile = encodeTile(sampleFrame(replyAnimation(), frame, this.size, this.size, levels), this.size, this.size, this.background ? vectorInk(this.background) : this.ink, this.background ?? [20, 20, 22]); this.frames.set(frame, tile); }
		const column = 1 + stringWidth(stripVTControlCharacters(token[1]!));
		return row.replace(frameToken, "$1 ") + `\x1b7\x1b[${column}G${tile}\x1b8`;
	}
}
