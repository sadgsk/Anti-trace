import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectSupportedImageMimeType, imageContentFromBytes, shrinkImageBytes } from "../../harness/tools/image.ts";
import type { ImageContent } from "../../types.ts";

const TIMEOUT_MS = 8000;

export interface PasteKey {
	name?: string;
	ctrl?: boolean;
	meta?: boolean;
	shift?: boolean;
}

/** Windows uses Alt+V because the terminal consumes Ctrl+V as a text paste. */
export function isImagePasteKey(key: PasteKey): boolean {
	if (key.name !== "v" || key.shift) {
		return false;
	}
	if (process.platform === "win32") {
		return key.meta === true && key.ctrl !== true;
	}
	return key.ctrl === true && key.meta !== true;
}

/**
 * Read an image from the clipboard.
 * Each platform tries a bitmap first, then a file path sitting on the clipboard.
 * The original file is never modified.
 */
export function readClipboardImage(): ImageContent | null {
	const captured = captureClipboard();
	if (!captured) {
		return null;
	}
	try {
		const bytes = new Uint8Array(readFileSync(captured));
		return imageContentFromBytes(shrinkImageBytes(bytes)) ?? null;
	} catch {
		return null;
	} finally {
		unlinkQuiet(captured);
	}
}

function captureClipboard(): string | null {
	const dest = tempImagePath();
	if (saveBitmap(dest)) {
		return dest;
	}
	unlinkQuiet(dest);
	const source = clipboardFilePath();
	if (!source || !existsSync(source) || !isImageFile(source)) {
		return null;
	}
	copyFileSync(source, dest);
	return dest;
}

function saveBitmap(filePath: string): boolean {
	if (process.platform === "win32") {
		return saveWindowsBitmap(filePath);
	}
	if (process.platform === "darwin") {
		return saveDarwinBitmap(filePath);
	}
	return saveLinuxBitmap(filePath);
}

function clipboardFilePath(): string | null {
	if (process.platform === "win32") {
		return windowsClipboardPath();
	}
	if (process.platform === "darwin") {
		return commandStdout("osascript", ["-e", "get POSIX path of (the clipboard as «class furl»)"]);
	}
	return linuxClipboardText();
}

function saveWindowsBitmap(filePath: string): boolean {
	const pathLiteral = psQuote(filePath);
	const script = [
		"Add-Type -AssemblyName System.Drawing",
		"$img = Get-Clipboard -Format Image",
		"if (-not $img) { Write-Output 'empty'; exit 0 }",
		`$img.Save(${pathLiteral}, [System.Drawing.Imaging.ImageFormat]::Png)`,
		"$img.Dispose()",
		"Write-Output 'ok'",
	].join("; ");
	const result = powershell(script);
	return result.status === 0 && result.stdout.trim() === "ok";
}

function windowsClipboardPath(): string | null {
	const listed = powershell(
		"$files = Get-Clipboard -Format FileDropList; if ($files -and $files.Count -gt 0) { Write-Output $files[0] }",
	);
	const fromList = firstExistingPath(listed.status === 0 ? listed.stdout : "");
	if (fromList) {
		return fromList;
	}
	const text = powershell("Get-Clipboard -Raw");
	return text.status === 0 ? firstExistingPath(text.stdout) : null;
}

function saveDarwinBitmap(filePath: string): boolean {
	const result = spawnSync(
		"osascript",
		[
			"-e",
			"set png_data to (the clipboard as «class PNGf»)",
			"-e",
			`set fp to open for access POSIX file "${filePath}" with write permission`,
			"-e",
			"write png_data to fp",
			"-e",
			"close access fp",
		],
		{ timeout: TIMEOUT_MS },
	);
	return result.status === 0 && existsSync(filePath);
}

function saveLinuxBitmap(filePath: string): boolean {
	const attempts: Array<[string, string[]]> = [
		["xclip", ["-selection", "clipboard", "-t", "image/png", "-o"]],
		["wl-paste", ["--type", "image/png"]],
		["xclip", ["-selection", "clipboard", "-t", "image/jpeg", "-o"]],
		["wl-paste", ["--type", "image/jpeg"]],
	];
	for (const [command, args] of attempts) {
		const result = spawnSync(command, args, { timeout: TIMEOUT_MS, maxBuffer: 50 * 1024 * 1024 });
		if (result.status === 0 && result.stdout.length > 0) {
			writeFileSync(filePath, result.stdout);
			return true;
		}
	}
	return false;
}

function linuxClipboardText(): string | null {
	const xclip = commandStdout("xclip", ["-selection", "clipboard", "-o"]);
	if (xclip) {
		return firstExistingPath(xclip);
	}
	return firstExistingPath(commandStdout("wl-paste", ["--no-newline"]) ?? "");
}

function isImageFile(filePath: string): boolean {
	try {
		return detectSupportedImageMimeType(new Uint8Array(readFileSync(filePath))) !== undefined;
	} catch {
		return false;
	}
}

function tempImagePath(): string {
	return join(tmpdir(), `anti-trace-clip-${randomUUID()}.img`);
}

function powershell(script: string): { status: number | null; stdout: string } {
	const result = spawnSync("powershell.exe", ["-STA", "-NoProfile", "-Command", script], {
		encoding: "utf8",
		timeout: TIMEOUT_MS,
		windowsHide: true,
	});
	return { status: result.status, stdout: result.stdout ?? "" };
}

function commandStdout(command: string, args: string[]): string | null {
	const result = spawnSync(command, args, { encoding: "utf8", timeout: TIMEOUT_MS });
	if (result.status !== 0) {
		return null;
	}
	const text = result.stdout.trim();
	return text.length > 0 ? text : null;
}

function firstExistingPath(text: string): string | null {
	for (const rawLine of text.split(/\r?\n/)) {
		const line = rawLine.trim().replace(/^["']|["']$/g, "");
		if (line.length > 0 && existsSync(line)) {
			return line;
		}
	}
	return null;
}

function psQuote(filePath: string): string {
	return `'${filePath.replaceAll("'", "''")}'`;
}

function unlinkQuiet(filePath: string): void {
	try {
		unlinkSync(filePath);
	} catch {
		// Already gone, or the capture step never created it.
	}
}
