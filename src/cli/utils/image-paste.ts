import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, join, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { detectSupportedImageMimeType, imageContentFromBytes } from "../../harness/tools/image.ts";
import type { ImageContent } from "../../types.ts";

const IMAGE_EXTENSION = /\.(?:png|jpe?g|gif|webp)$/i;
const MAX_IMAGE_EDGE = 2000;
const COMMAND_TIMEOUT_MS = 8000;
const MAX_COMMAND_BYTES = 50 * 1024 * 1024;
const CLIPBOARD_MIME_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;

export interface PastedImage {
	image: ImageContent;
	filename?: string;
	sourcePath?: string;
}

/** `text` is always an exact slice of the paste, including quotes and escapes. */
export interface ImagePathPart {
	text: string;
	path?: string;
}

/**
 * Recognize quoted/escaped image paths without interpreting shell commands.
 * Ordinary text and whitespace remain in order so failed reads can be inserted verbatim.
 */
export function splitImagePathParts(text: string): ImagePathPart[] {
	const parts: ImagePathPart[] = [];
	let plainStart = 0;
	let offset = 0;
	while (offset < text.length) {
		if (/\s/u.test(text[offset]!)) {
			offset++;
			continue;
		}
		const start = offset;
		const token = readPathToken(text, start);
		offset = token.end;
		const path = token.closed ? normalizeImagePath(token.value) : null;
		if (path === null) continue;
		if (plainStart < start) parts.push({ text: text.slice(plainStart, start) });
		parts.push({ text: text.slice(start, offset), path });
		plainStart = offset;
	}
	if (plainStart < text.length) parts.push({ text: text.slice(plainStart) });
	return parts;
}

export function hasImageFilePath(text: string): boolean {
	return splitImagePathParts(text).some(part => part.path !== undefined);
}

function readPathToken(text: string, start: number): { value: string; end: number; closed: boolean } {
	// Windows separators are literal even when this parser runs on another platform.
	const tokenStart = text.slice(start);
	const unixPath = /^(?:["'])?(?:\/|\.{1,2}\/|~\/)/u.test(tokenStart);
	const windowsPath = /^(?:["'])?(?:[a-z]:[\\/]|\\\\)/i.test(tokenStart) || (process.platform === "win32" && !unixPath);
	const quotedToken = text[start] === "'" || text[start] === '"';
	let quote: "'" | '"' | undefined;
	let value = "";
	let offset = start;
	while (offset < text.length) {
		const char = text[offset]!;
		if (quote === undefined && /\s/u.test(char)) break;
		if (char === quote) {
			quote = undefined;
			offset++;
			continue;
		}
		if (quotedToken && quote === undefined && (char === "'" || char === '"')) {
			quote = char;
			offset++;
			continue;
		}
		if (!windowsPath && char === "\\" && quote !== "'" && offset + 1 < text.length) {
			const next = text[offset + 1]!;
			// Within double quotes, a backslash only escapes shell quote characters.
			if (quote === undefined || /[\\"$`\n]/u.test(next)) {
				value += next;
				offset += 2;
				continue;
			}
		}
		value += char;
		offset++;
	}
	return { value, end: offset, closed: quote === undefined };
}

function normalizeImagePath(path: string): string | null {
	if (path.includes("\0")) return null;
	if (/^file:/i.test(path)) {
		try {
			const url = new URL(path);
			if (url.search || url.hash) return null;
			const windows = /^\/[a-z]:\//i.test(url.pathname) || (url.hostname !== "" && url.hostname !== "localhost");
			path = fileURLToPath(url, { windows });
		} catch {
			return null;
		}
	} else if (/^[a-z][a-z\d+.-]*:\/\//i.test(path)) {
		return null;
	}
	if (!IMAGE_EXTENSION.test(path)) return null;
	return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

/** Read a decoded path from `splitImagePathParts`; the source file is never modified. */
export async function readImageFromPath(path: string): Promise<PastedImage | null> {
	const sourcePath = normalizeImagePath(path);
	if (sourcePath === null) return null;
	try {
		const image = await imageFromBytes(await readFile(sourcePath));
		if (!image) return null;
		return {
			image,
			filename: /^[a-z]:[\\/]|^\\\\/i.test(sourcePath) ? win32.basename(sourcePath) : basename(sourcePath),
			sourcePath,
		};
	} catch {
		return null;
	}
}

/**
 * Try a clipboard bitmap, then image file paths on the clipboard.
 * Commands are asynchronous, shell-free, and bounded; temporary files are always removed.
 */
export async function readClipboardImageAsync(): Promise<PastedImage | null> {
	try {
		const deadline = Date.now() + COMMAND_TIMEOUT_MS;
		let bitmap: Buffer | null = null;
		if (process.platform === "darwin" || process.platform === "win32") {
			bitmap = await captureDesktopBitmap(deadline);
		} else if (process.platform === "linux") {
			bitmap = await captureLinuxBitmap(deadline);
		} else {
			return null;
		}
		if (bitmap) {
			const image = await imageFromBytes(bitmap);
			if (image) return { image };
		}
		const text = await clipboardPathText(deadline);
		if (!text) return null;
		// File-drop lists and clipboard text may contain raw paths with spaces.
		for (const line of text.split(/\r?\n/u)) {
			const image = await readImageFromPath(line.trim());
			if (image) return image;
		}
		for (const part of splitImagePathParts(text)) {
			if (part.path === undefined) continue;
			const image = await readImageFromPath(part.path);
			if (image) return image;
		}
		return null;
	} catch {
		return null;
	}
}

async function imageFromBytes(bytes: Buffer): Promise<ImageContent | null> {
	const dimensions = validatedImageDimensions(bytes);
	if (!dimensions) return null;
	const resized = await resizeImageBytes(bytes, dimensions);
	return imageContentFromBytes(resized) ?? null;
}

interface ImageDimensions { width: number; height: number }

async function resizeImageBytes(bytes: Buffer, dimensions: ImageDimensions): Promise<Buffer> {
	if (dimensions.width <= MAX_IMAGE_EDGE && dimensions.height <= MAX_IMAGE_EDGE) return bytes;
	let directory: string | undefined;
	try {
		directory = await mkdtemp(join(tmpdir(), "anti-trace-image-"));
		const input = join(directory, "input.img");
		const output = join(directory, "resized.png");
		await writeFile(input, bytes);
		let result: Buffer | null = null;
		if (process.platform === "darwin") {
			result = await runCommand("sips", ["-Z", String(MAX_IMAGE_EDGE), input, "--out", output]);
		} else if (process.platform === "win32") {
			result = await powershell([
				"Add-Type -AssemblyName System.Drawing",
				`$img = [System.Drawing.Image]::FromFile(${psQuote(input)})`,
				"try {",
				`if ($img.Width -le ${MAX_IMAGE_EDGE} -and $img.Height -le ${MAX_IMAGE_EDGE}) { exit 0 }`,
				`$scale = [Math]::Min(${MAX_IMAGE_EDGE} / [double]$img.Width, ${MAX_IMAGE_EDGE} / [double]$img.Height)`,
				"$width = [int][Math]::Max(1, [Math]::Floor($img.Width * $scale))",
				"$height = [int][Math]::Max(1, [Math]::Floor($img.Height * $scale))",
				"$bmp = New-Object System.Drawing.Bitmap $width, $height",
				"try { $graphics = [System.Drawing.Graphics]::FromImage($bmp)",
				"try { $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic; $graphics.DrawImage($img, 0, 0, $width, $height) } finally { $graphics.Dispose() }",
				`$bmp.Save(${psQuote(output)}, [System.Drawing.Imaging.ImageFormat]::Png)`,
				"} finally { $bmp.Dispose() }",
				"} finally { $img.Dispose() }",
			].join("; "));
		} else if (process.platform === "linux") {
			const args = [input, "-resize", `${MAX_IMAGE_EDGE}x${MAX_IMAGE_EDGE}>`, output];
			result = await runCommand("magick", args) ?? await runCommand("convert", args);
		}
		if (result === null) return bytes;
		const resized = await readFile(output);
		return validatedImageDimensions(resized) ? resized : bytes;
	} catch {
		return bytes;
	} finally {
		if (directory) await rm(directory, { recursive: true, force: true }).catch(() => {});
	}
}

/** Basic container/header checks, including dimensions; this does not decode pixels. */
function validatedImageDimensions(bytes: Buffer): ImageDimensions | null {
	switch (detectSupportedImageMimeType(bytes)) {
		case "image/png": return pngDimensions(bytes);
		case "image/jpeg": return jpegDimensions(bytes);
		case "image/gif": return gifDimensions(bytes);
		case "image/webp": return webpDimensions(bytes);
		default: return null;
	}
}

function pngDimensions(bytes: Buffer): ImageDimensions | null {
	let dimensions: ImageDimensions | null = null;
	let imageDataBytes = 0;
	let hasPalette = false;
	let colorType = 0;
	let offset = 8;
	while (offset + 12 <= bytes.length) {
		const length = bytes.readUInt32BE(offset);
		const data = offset + 8;
		const end = data + length + 4;
		if (end > bytes.length) return null;
		const kind = bytes.toString("ascii", offset + 4, data);
		if (!/^[a-z]{4}$/i.test(kind) || kind === "acTL") return null;
		if (offset === 8 && kind !== "IHDR") return null;
		if (kind === "IHDR") {
			if (dimensions || length !== 13) return null;
			dimensions = positiveDimensions(bytes.readUInt32BE(data), bytes.readUInt32BE(data + 4));
			if (!dimensions || dimensions.width > 0x7fffffff || dimensions.height > 0x7fffffff) return null;
			colorType = bytes[data + 9]!;
			const depths: Record<number, readonly number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
			if (!depths[colorType]?.includes(bytes[data + 8]!) || bytes[data + 10] !== 0 || bytes[data + 11] !== 0 || bytes[data + 12]! > 1) return null;
		} else if (kind === "PLTE") {
			if (hasPalette || imageDataBytes > 0 || length === 0 || length > 768 || length % 3 !== 0) return null;
			hasPalette = true;
		} else if (kind === "IDAT") {
			if (colorType === 3 && !hasPalette) return null;
			imageDataBytes += length;
		} else if (kind === "IEND") {
			return length === 0 && end === bytes.length && imageDataBytes > 0 ? dimensions : null;
		}
		offset = end;
	}
	return null;
}

function jpegDimensions(bytes: Buffer): ImageDimensions | null {
	let dimensions: ImageDimensions | null = null;
	let hasScan = false;
	let inScan = false;
	let entropyBytes = 0;
	let offset = 2;
	while (offset < bytes.length) {
		if (inScan) {
			if (bytes[offset] !== 0xff) { entropyBytes++; offset++; continue; }
			if (bytes[offset + 1] === 0x00) { entropyBytes++; offset += 2; continue; }
			if (bytes[offset + 1]! >= 0xd0 && bytes[offset + 1]! <= 0xd7) { offset += 2; continue; }
			inScan = false;
		}
		if (bytes[offset++] !== 0xff) return null;
		while (bytes[offset] === 0xff) offset++;
		if (offset >= bytes.length) return null;
		const marker = bytes[offset++]!;
		if (marker === 0xd9) return offset === bytes.length && hasScan && entropyBytes > 0 ? dimensions : null;
		if (marker === 0x01) continue;
		if (marker === 0x00 || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || offset + 2 > bytes.length) return null;
		const length = bytes.readUInt16BE(offset);
		const data = offset + 2;
		if (length < 2 || offset + length > bytes.length) return null;
		if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
			if (dimensions || length < 11) return null;
			const components = bytes[data + 5]!;
			if (components === 0 || length !== 8 + 3 * components || bytes[data]! === 0 || bytes[data]! > 16) return null;
			dimensions = positiveDimensions(bytes.readUInt16BE(data + 3), bytes.readUInt16BE(data + 1));
			if (!dimensions) return null;
		} else if (marker === 0xda) {
			if (!dimensions || length < 8 || bytes[data] === 0 || length !== 6 + 2 * bytes[data]!) return null;
			hasScan = true;
			inScan = true;
		}
		offset += length;
	}
	return null;
}

function gifDimensions(bytes: Buffer): ImageDimensions | null {
	if (bytes.length < 14 || !["GIF87a", "GIF89a"].includes(bytes.toString("ascii", 0, 6))) return null;
	const dimensions = positiveDimensions(bytes.readUInt16LE(6), bytes.readUInt16LE(8));
	if (!dimensions) return null;
	let offset = 13 + ((bytes[10]! & 0x80) ? 3 * (1 << ((bytes[10]! & 7) + 1)) : 0);
	let hasImage = false;
	while (offset < bytes.length) {
		const marker = bytes[offset++]!;
		if (marker === 0x3b) return offset === bytes.length && hasImage ? dimensions : null;
		if (marker === 0x21) {
			if (offset >= bytes.length) return null;
			const label = bytes[offset++]!;
			if (label === 0xf9 && (bytes[offset] !== 4 || offset + 6 > bytes.length || bytes[offset + 5] !== 0)) return null;
			if (label === 0x01 && bytes[offset] !== 12) return null;
			if (label === 0xff && bytes[offset] !== 11) return null;
		} else if (marker === 0x2c) {
			if (offset + 9 > bytes.length) return null;
			const image = positiveDimensions(bytes.readUInt16LE(offset + 4), bytes.readUInt16LE(offset + 6));
			if (!image || bytes.readUInt16LE(offset) + image.width > dimensions.width || bytes.readUInt16LE(offset + 2) + image.height > dimensions.height) return null;
			const packed = bytes[offset + 8]!;
			offset += 9 + ((packed & 0x80) ? 3 * (1 << ((packed & 7) + 1)) : 0);
			if (offset >= bytes.length || bytes[offset]! < 2 || bytes[offset]! > 8) return null;
			offset++;
			if (bytes[offset] === 0) return null;
			hasImage = true;
		} else {
			return null;
		}
		offset = gifSubBlockEnd(bytes, offset);
		if (offset < 0) return null;
	}
	return null;
}

function gifSubBlockEnd(bytes: Buffer, offset: number): number {
	while (offset < bytes.length) {
		const length = bytes[offset++]!;
		if (length === 0) return offset;
		offset += length;
	}
	return -1;
}

interface WebpChunk { kind: string; data: Buffer }

function webpChunks(bytes: Buffer, offset: number): WebpChunk[] | null {
	const chunks: WebpChunk[] = [];
	while (offset + 8 <= bytes.length) {
		const length = bytes.readUInt32LE(offset + 4);
		const end = offset + 8 + length;
		if (end + (length % 2) > bytes.length) return null;
		chunks.push({ kind: bytes.toString("ascii", offset, offset + 4), data: bytes.subarray(offset + 8, end) });
		offset = end + (length % 2);
	}
	return offset === bytes.length ? chunks : null;
}

function webpFrameDimensions(chunks: readonly WebpChunk[]): ImageDimensions | null {
	let dimensions: ImageDimensions | null = null;
	for (const { kind, data } of chunks) {
		if (kind === "VP8 ") {
			if (dimensions || data.length <= 10 || (data[0]! & 1) || data[3] !== 0x9d || data[4] !== 0x01 || data[5] !== 0x2a) return null;
			dimensions = positiveDimensions(data.readUInt16LE(6) & 0x3fff, data.readUInt16LE(8) & 0x3fff);
			if (!dimensions) return null;
		} else if (kind === "VP8L") {
			if (dimensions || data.length <= 5 || data[0] !== 0x2f) return null;
			const bits = data.readUInt32LE(1);
			if (bits >>> 29) return null;
			dimensions = { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
		}
	}
	return dimensions;
}

function webpDimensions(bytes: Buffer): ImageDimensions | null {
	if (bytes.length < 20 || bytes.readUInt32LE(4) !== bytes.length - 8) return null;
	const chunks = webpChunks(bytes, 12);
	if (!chunks?.length) return null;
	const extended = chunks.find(chunk => chunk.kind === "VP8X");
	if (!extended) return webpFrameDimensions(chunks);
	if (extended !== chunks[0] || chunks.filter(chunk => chunk.kind === "VP8X").length !== 1 || extended.data.length !== 10) return null;
	const data = extended.data;
	if ((data[0]! & 0xc1) || data[1] || data[2] || data[3]) return null;
	const dimensions = { width: data.readUIntLE(4, 3) + 1, height: data.readUIntLE(7, 3) + 1 };
	if (!(data[0]! & 2)) {
		const frame = webpFrameDimensions(chunks);
		return frame?.width === dimensions.width && frame.height === dimensions.height ? dimensions : null;
	}
	if (chunks.filter(chunk => chunk.kind === "ANIM" && chunk.data.length === 6).length !== 1 || chunks.some(chunk => chunk.kind === "VP8 " || chunk.kind === "VP8L")) return null;
	let frames = 0;
	for (const chunk of chunks) {
		if (chunk.kind !== "ANMF") continue;
		const frame = chunk.data;
		if (frame.length < 24 || (frame[15]! & 0xfc)) return null;
		const width = frame.readUIntLE(6, 3) + 1;
		const height = frame.readUIntLE(9, 3) + 1;
		if (frame.readUIntLE(0, 3) * 2 + width > dimensions.width || frame.readUIntLE(3, 3) * 2 + height > dimensions.height) return null;
		const inner = webpChunks(frame, 16);
		const image = inner && webpFrameDimensions(inner);
		if (image?.width !== width || image.height !== height) return null;
		frames++;
	}
	return frames > 0 ? dimensions : null;
}

function positiveDimensions(width: number, height: number): ImageDimensions | null {
	return width > 0 && height > 0 ? { width, height } : null;
}

async function captureDesktopBitmap(deadline: number): Promise<Buffer | null> {
	let directory: string | undefined;
	try {
		directory = await mkdtemp(join(tmpdir(), "anti-trace-clipboard-"));
		const output = join(directory, "clipboard.png");
		let result: Buffer | null;
		if (process.platform === "win32") {
			result = await powershell([
				"Add-Type -AssemblyName System.Drawing",
				"$img = Get-Clipboard -Format Image",
				"if (-not $img) { exit 1 }",
				`try { $img.Save(${psQuote(output)}, [System.Drawing.Imaging.ImageFormat]::Png) } finally { $img.Dispose() }`,
			].join("; "), deadline);
		} else {
			result = await runCommand("osascript", [
				"-e", "set png_data to (the clipboard as «class PNGf»)",
				"-e", `set fp to open for access POSIX file ${appleScriptQuote(output)} with write permission`,
				"-e", "write png_data to fp",
				"-e", "close access fp",
			], deadline);
		}
		return result === null ? null : await readFile(output);
	} catch {
		return null;
	} finally {
		if (directory) await rm(directory, { recursive: true, force: true }).catch(() => {});
	}
}

async function captureLinuxBitmap(deadline: number): Promise<Buffer | null> {
	const readers = [
		{ command: "xclip", listArgs: ["-selection", "clipboard", "-t", "TARGETS", "-o"], readArgs: (mime: string) => ["-selection", "clipboard", "-t", mime, "-o"] },
		{ command: "wl-paste", listArgs: ["--list-types"], readArgs: (mime: string) => ["--type", mime, "--no-newline"] },
	];
	for (const reader of readers) {
		const targets = await runCommand(reader.command, reader.listArgs, deadline);
		if (!targets) continue;
		const offered = new Set(targets.toString("utf8").trim().split(/\s+/u));
		for (const mime of CLIPBOARD_MIME_TYPES) {
			if (!offered.has(mime)) continue;
			const bytes = await runCommand(reader.command, reader.readArgs(mime), deadline);
			if (bytes && validatedImageDimensions(bytes)) return bytes;
		}
	}
	return null;
}

async function clipboardPathText(deadline: number): Promise<string | null> {
	if (process.platform === "darwin") {
		const file = await runCommand("osascript", ["-e", "get POSIX path of (the clipboard as «class furl»)"], deadline);
		if (file?.length) return file.toString("utf8");
		return (await runCommand("pbpaste", [], deadline))?.toString("utf8") ?? null;
	}
	if (process.platform === "win32") {
		return (await powershell([
			"$files = Get-Clipboard -Format FileDropList",
			"if ($files -and $files.Count -gt 0) { foreach ($path in $files) { [Console]::WriteLine($path) } } else { Get-Clipboard -Raw }",
		].join("; "), deadline))?.toString("utf8") ?? null;
	}
	for (const [command, args] of [
		["xclip", ["-selection", "clipboard", "-t", "text/uri-list", "-o"]],
		["wl-paste", ["--type", "text/uri-list", "--no-newline"]],
		["xclip", ["-selection", "clipboard", "-o"]],
		["wl-paste", ["--no-newline"]],
	] as Array<[string, string[]]>) {
		const result = await runCommand(command, args, deadline);
		if (result?.length) return result.toString("utf8");
	}
	return null;
}

function runCommand(command: string, args: string[], deadline?: number): Promise<Buffer | null> {
	const timeout = deadline === undefined ? COMMAND_TIMEOUT_MS : Math.min(COMMAND_TIMEOUT_MS, deadline - Date.now());
	if (timeout <= 0) return Promise.resolve(null);
	return new Promise(resolve => {
		execFile(command, args, { encoding: "buffer", timeout, killSignal: "SIGKILL", windowsHide: true, maxBuffer: MAX_COMMAND_BYTES }, (error, stdout) => {
			resolve(error ? null : stdout);
		});
	});
}

function powershell(script: string, deadline?: number): Promise<Buffer | null> {
	const prelude = "$ErrorActionPreference = 'Stop'; [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false; ";
	return runCommand("powershell.exe", ["-STA", "-NoProfile", "-NonInteractive", "-Command", prelude + script], deadline);
}

function psQuote(path: string): string {
	return `'${path.replaceAll("'", "''")}'`;
}

function appleScriptQuote(path: string): string {
	return `"${path.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}
