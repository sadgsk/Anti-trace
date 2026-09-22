import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ImageContent } from "../../types.ts";

const MAX_IMAGE_EDGE = 2000;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Return a MIME type for JPEG, PNG, GIF, or WebP. Animated PNG is rejected. */
export function detectSupportedImageMimeType(buffer: Uint8Array): string | undefined {
	if (startsWith(buffer, [0xff, 0xd8, 0xff])) {
		return buffer[3] === 0xf7 ? undefined : "image/jpeg";
	}
	if (startsWith(buffer, PNG_SIGNATURE)) {
		return isPng(buffer) && !isAnimatedPng(buffer) ? "image/png" : undefined;
	}
	if (startsWithAscii(buffer, 0, "GIF")) {
		return "image/gif";
	}
	if (startsWithAscii(buffer, 0, "RIFF") && startsWithAscii(buffer, 8, "WEBP")) {
		return "image/webp";
	}
	return undefined;
}

function isPng(buffer: Uint8Array): boolean {
	return (
		buffer.length >= 16 && readUint32BE(buffer, PNG_SIGNATURE.length) === 13 && startsWithAscii(buffer, 12, "IHDR")
	);
}

function isAnimatedPng(buffer: Uint8Array): boolean {
	let offset = PNG_SIGNATURE.length;
	while (offset + 8 <= buffer.length) {
		const chunkLength = readUint32BE(buffer, offset);
		const chunkTypeOffset = offset + 4;
		if (startsWithAscii(buffer, chunkTypeOffset, "acTL")) {
			return true;
		}
		if (startsWithAscii(buffer, chunkTypeOffset, "IDAT")) {
			return false;
		}
		const nextOffset = offset + 8 + chunkLength + 4;
		if (nextOffset <= offset || nextOffset > buffer.length) {
			return false;
		}
		offset = nextOffset;
	}
	return false;
}

function readUint32BE(buffer: Uint8Array, offset: number): number {
	return (
		(buffer[offset] ?? 0) * 0x1000000 +
		((buffer[offset + 1] ?? 0) << 16) +
		((buffer[offset + 2] ?? 0) << 8) +
		(buffer[offset + 3] ?? 0)
	);
}

function startsWith(buffer: Uint8Array, bytes: number[]): boolean {
	if (buffer.length < bytes.length) {
		return false;
	}
	return bytes.every((byte, index) => buffer[index] === byte);
}

function startsWithAscii(buffer: Uint8Array, offset: number, text: string): boolean {
	if (buffer.length < offset + text.length) {
		return false;
	}
	for (let index = 0; index < text.length; index++) {
		if (buffer[offset + index] !== text.charCodeAt(index)) {
			return false;
		}
	}
	return true;
}

/** Pack supported image bytes into a message block. Unsupported bytes return undefined. */
export function imageContentFromBytes(bytes: Uint8Array): ImageContent | undefined {
	const mimeType = detectSupportedImageMimeType(bytes);
	if (!mimeType) {
		return undefined;
	}
	return {
		type: "image",
		data: Buffer.from(bytes).toString("base64"),
		mimeType,
	};
}

/** Shrink bytes so the longest edge is at most 2000. Smaller images and failures stay unchanged. */
export function shrinkImageBytes(bytes: Uint8Array): Uint8Array {
	if (!detectSupportedImageMimeType(bytes)) {
		return bytes;
	}
	const filePath = join(tmpdir(), `anti-trace-read-${randomUUID()}.img`);
	const resizedPath = `${filePath}.resized.png`;
	try {
		writeFileSync(filePath, bytes);
		const shrunkPath = shrinkImageFile(filePath, resizedPath);
		return new Uint8Array(readFileSync(shrunkPath));
	} catch {
		return bytes;
	} finally {
		unlinkQuiet(filePath);
		unlinkQuiet(resizedPath);
	}
}

function shrinkImageFile(filePath: string, resizedPath: string): string {
	if (process.platform === "win32") {
		return shrinkImageFileWindows(filePath, resizedPath);
	}
	if (process.platform === "darwin") {
		shrinkImageFileDarwin(filePath);
		return filePath;
	}
	shrinkImageFileLinux(filePath);
	return filePath;
}

function shrinkImageFileWindows(filePath: string, resizedPath: string): string {
	const script = [
		"Add-Type -AssemblyName System.Drawing",
		`$img = [System.Drawing.Image]::FromFile(${psQuote(filePath)})`,
		"$w = [double]$img.Width",
		"$h = [double]$img.Height",
		`$max = ${MAX_IMAGE_EDGE}`,
		"if ($w -le $max -and $h -le $max) { $img.Dispose(); Write-Output 'skip'; exit 0 }",
		"$scale = [Math]::Min($max / $w, $max / $h)",
		"$nw = [int][Math]::Max(1, [Math]::Round($w * $scale))",
		"$nh = [int][Math]::Max(1, [Math]::Round($h * $scale))",
		"$bmp = New-Object System.Drawing.Bitmap $nw, $nh",
		"$g = [System.Drawing.Graphics]::FromImage($bmp)",
		"$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic",
		"$g.DrawImage($img, 0, 0, $nw, $nh)",
		"$g.Dispose()",
		"$img.Dispose()",
		`$bmp.Save(${psQuote(resizedPath)}, [System.Drawing.Imaging.ImageFormat]::Png)`,
		"$bmp.Dispose()",
		"Write-Output 'resized'",
	].join("; ");
	const result = spawnSync("powershell.exe", ["-STA", "-NoProfile", "-Command", script], {
		encoding: "utf8",
		timeout: 8000,
		windowsHide: true,
	});
	if (result.status === 0 && result.stdout.trim() === "resized") {
		return resizedPath;
	}
	return filePath;
}

function shrinkImageFileDarwin(filePath: string): void {
	const info = spawnSync("sips", ["-g", "pixelWidth", "-g", "pixelHeight", filePath], {
		encoding: "utf8",
		timeout: 8000,
	});
	if (info.status !== 0) {
		return;
	}
	const width = Number(info.stdout.match(/pixelWidth: (\d+)/)?.[1] ?? 0);
	const height = Number(info.stdout.match(/pixelHeight: (\d+)/)?.[1] ?? 0);
	if (width > MAX_IMAGE_EDGE || height > MAX_IMAGE_EDGE) {
		spawnSync("sips", ["-Z", String(MAX_IMAGE_EDGE), filePath], { timeout: 8000 });
	}
}

function shrinkImageFileLinux(filePath: string): void {
	const geometry = `${MAX_IMAGE_EDGE}x${MAX_IMAGE_EDGE}>`;
	const magick = spawnSync("magick", [filePath, "-resize", geometry, filePath], { timeout: 8000 });
	if (magick.error || magick.status !== 0) {
		spawnSync("convert", [filePath, "-resize", geometry, filePath], { timeout: 8000 });
	}
}

function psQuote(filePath: string): string {
	return `'${filePath.replaceAll("'", "''")}'`;
}

function unlinkQuiet(filePath: string): void {
	try {
		unlinkSync(filePath);
	} catch {
		// The temp file was never created, or it was already removed.
	}
}
