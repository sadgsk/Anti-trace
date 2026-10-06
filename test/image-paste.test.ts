import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { hasImageFilePath, readClipboardImageAsync, readImageFromPath, splitImagePathParts } from "../src/cli/utils/image-paste.ts";

const PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4//8/AAX+Av4N70a4AAAAAElFTkSuQmCC",
	"base64",
);

// Valid 1×1 fixtures, encoded with sips (JPEG/GIF) and libwebp (VP8/VP8L/animation).
const JPEG = Buffer.from(
	"/9j/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9sAQwACAgICAgIDAgIDBQMDAwUGBQUFBQYIBgYGBgYICggICAgICAoKCgoKCgoKDAwMDAwMDg4ODg4PDw8PDw8PDw8P/9sAQwECAgIEBAQHBAQHEAsJCxAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQ/90ABAAB/9oADAMBAAIRAxEAPwD9/KKKKAP/2Q==",
	"base64",
);
const GIF = Buffer.from("R0lGODdhAQABAIAAAAAAAP///yH5BAQAAAAALAAAAAABAAEAAAICTAEAOw==", "base64");
const WEBP = Buffer.from("UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAUAmJaQAA3AA/vz0AAA=", "base64");
const LOSSLESS_WEBP = Buffer.from("UklGRh4AAABXRUJQVlA4TBEAAAAvAAAAAAfQ//73v/+BiOh/AAA=", "base64");
const ANIMATED_WEBP = Buffer.from("UklGRoQAAABXRUJQVlA4WAoAAAACAAAAAAAAAAAAQU5JTQYAAAAAAAAAAABBTk1GKgAAAAAAAAAAAAAAAAAAAGQAAAJWUDhMEQAAAC8AAAAAB9D//ve//4GI6H8AAEFOTUYmAAAAAAAAAAAAAAAAAAAAZAAAAFZQOEwOAAAALwAAAAAHEBH9D0RE/wM=", "base64");
const LARGE_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAC7kAAAABCAIAAAAudx9XAAAAH0lEQVR4nO3BAQEAAAABIP9PM0SVAgAAAAAAAADAhwH5uwnjQhPKogAAAABJRU5ErkJggg==", "base64");

test("mixed text, image paths and whitespace retain their exact original order", () => {
	const text = String.raw`intro  "/tmp/screen one.png"
 ./assets/two\ three.JPG` + "\t" + String.raw`~/四.gif file:///tmp/uri%20four.webp C:\Users\Kyson\five.png '\\server\share\six picture.jpeg' end`;
	const parts = splitImagePathParts(text);
	assert.equal(parts.map(part => part.text).join(""), text);
	assert.deepEqual(parts.filter(part => part.path !== undefined).map(part => part.path), [
		"/tmp/screen one.png",
		"./assets/two three.JPG",
		join(homedir(), "四.gif"),
		"/tmp/uri four.webp",
		String.raw`C:\Users\Kyson\five.png`,
		String.raw`\\server\share\six picture.jpeg`,
	]);
	assert.deepEqual(parts[0], { text: "intro  " });
	assert.deepEqual(parts.at(-1), { text: " end" });
});

test("plain text, malformed paths and unmatched quotes stay unchanged", () => {
	for (const text of [
		"ordinary text\n\twith whitespace ",
		"https://example.com/image.png",
		"file:///tmp/invalid%ZZ.png",
		"file:///tmp/image.png?download=yes",
		"'/tmp/unclosed.png rest",
		"bad\0.png",
	]) {
		assert.deepEqual(splitImagePathParts(text), [{ text }]);
		assert.equal(hasImageFilePath(text), false);
	}
	assert.deepEqual(splitImagePathParts(""), []);
});

test("apostrophes in prose do not hide following paths, and bare filenames are relative paths", () => {
	assert.deepEqual(splitImagePathParts("don't attach /tmp/image.png yet"), [
		{ text: "don't attach " },
		{ text: "/tmp/image.png", path: "/tmp/image.png" },
		{ text: " yet" },
	]);
	assert.equal(hasImageFilePath("see picture.webp"), true);
	assert.deepEqual(splitImagePathParts("picture.webp"), [{ text: "picture.webp", path: "picture.webp" }]);
});

test("shell-looking names are literal paths and Windows file URLs preserve drive/UNC syntax", () => {
	const quoted = String.raw`'$(touch ignored).png' '/tmp/O'\''Reilly.png'`;
	assert.deepEqual(splitImagePathParts(quoted).filter(part => part.path).map(part => part.path), [
		"$(touch ignored).png", "/tmp/O'Reilly.png",
	]);
	assert.deepEqual(splitImagePathParts("file:///C:/Users/me/my%20image.png file://server/share/photo.jpg"), [
		{ text: "file:///C:/Users/me/my%20image.png", path: String.raw`C:\Users\me\my image.png` },
		{ text: " " },
		{ text: "file://server/share/photo.jpg", path: String.raw`\\server\share\photo.jpg` },
	]);
});

test("actual PNG reading uses magic MIME, preserves source bytes and accepts file URLs", async () => {
	const directory = await mkdtemp(join(tmpdir(), "anti-trace-image-test-"));
	try {
		const path = join(directory, "literal $(command) image.jpg");
		await writeFile(path, PNG);
		const parsed = splitImagePathParts(`'${path}'`);
		assert.equal(parsed[0]?.path, path);
		const pasted = await readImageFromPath(parsed[0]!.path!);
		assert.deepEqual(pasted, {
			image: { type: "image", data: PNG.toString("base64"), mimeType: "image/png" },
			filename: "literal $(command) image.jpg",
			sourcePath: path,
		});
		assert.deepEqual(await readFile(path), PNG);
		assert.deepEqual(await readImageFromPath(pathToFileURL(path).href), pasted);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("missing, empty, non-image and unsupported files return null", async () => {
	const directory = await mkdtemp(join(tmpdir(), "anti-trace-image-test-"));
	try {
		const empty = join(directory, "empty.png");
		const invalid = join(directory, "invalid.jpg");
		const unsupported = join(directory, "bitmap.bmp");
		await Promise.all([writeFile(empty, ""), writeFile(invalid, "not an image"), writeFile(unsupported, "BMbad")]);
		for (const path of [empty, invalid, unsupported, join(directory, "missing.webp"), "file:///broken%ZZ.png"]) {
			assert.equal(await readImageFromPath(path), null, path);
		}
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("valid small JPEG, GIF, VP8, VP8L and animated WebP preserve their original bytes", async () => {
	const directory = await mkdtemp(join(tmpdir(), "anti-trace-image-test-"));
	try {
		for (const [name, bytes, mimeType] of [
			["pixel.jpg", JPEG, "image/jpeg"],
			["pixel.gif", GIF, "image/gif"],
			["pixel.webp", WEBP, "image/webp"],
			["lossless.webp", LOSSLESS_WEBP, "image/webp"],
			["animated.webp", ANIMATED_WEBP, "image/webp"],
		] as const) {
			const path = join(directory, name);
			await writeFile(path, bytes);
			assert.deepEqual((await readImageFromPath(path))?.image, { type: "image", data: bytes.toString("base64"), mimeType }, name);
		}
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("truncated image containers and missing terminal chunks remain failed reads", async () => {
	const directory = await mkdtemp(join(tmpdir(), "anti-trace-image-test-"));
	try {
		const malformed: Array<[string, Buffer]> = [
			["png-16.png", PNG.subarray(0, 16)],
			["png-24.png", PNG.subarray(0, 24)],
			["png-33.png", PNG.subarray(0, 33)],
			["png-no-iend.png", PNG.subarray(0, PNG.length - 12)],
			["png-cut-idat.png", PNG.subarray(0, 45)],
			["jpeg-magic.jpg", Buffer.from([0xff, 0xd8, 0xff])],
			["jpeg-cut-sof.jpg", JPEG.subarray(0, 12)],
			["jpeg-no-eoi.jpg", JPEG.subarray(0, JPEG.length - 2)],
			["gif-header.gif", GIF.subarray(0, 10)],
			["gif-no-trailer.gif", GIF.subarray(0, GIF.length - 1)],
			["gif-cut-subblock.gif", GIF.subarray(0, GIF.length - 3)],
			["webp-riff.webp", WEBP.subarray(0, 12)],
			["webp-cut-chunk.webp", WEBP.subarray(0, WEBP.length - 1)],
			["webp-lossless-cut.webp", LOSSLESS_WEBP.subarray(0, 25)],
			["webp-animation-cut.webp", ANIMATED_WEBP.subarray(0, ANIMATED_WEBP.length - 1)],
		];
		const pngBadDimensions = Buffer.from(PNG);
		pngBadDimensions.writeUInt32BE(0, 16);
		malformed.push(["png-zero-width.png", pngBadDimensions]);
		const pngOversizedChunk = Buffer.from(PNG);
		pngOversizedChunk.writeUInt32BE(0xffffffff, 33);
		malformed.push(["png-chunk-overflow.png", pngOversizedChunk]);
		const webpBadChunk = Buffer.from(WEBP);
		webpBadChunk.writeUInt32LE(0xffffffff, 16);
		malformed.push(["webp-chunk-overflow.webp", webpBadChunk]);
		const webpHeaderOnly = Buffer.from(ANIMATED_WEBP.subarray(0, 30));
		webpHeaderOnly.writeUInt32LE(webpHeaderOnly.length - 8, 4);
		malformed.push(["webp-extended-no-image.webp", webpHeaderOnly]);
		for (const [name, bytes] of malformed) {
			const path = join(directory, name);
			await writeFile(path, bytes);
			assert.equal(await readImageFromPath(path), null, name);
		}
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("failed resize commands retain a valid large image and remove their private temp directory", {
	skip: process.platform !== "darwin" && process.platform !== "linux",
}, async () => {
	const directory = await mkdtemp(join(tmpdir(), "anti-trace-resize-test-"));
	const oldPath = process.env.PATH;
	try {
		const imagePath = join(directory, "large.png");
		const captureLog = join(directory, "resize-directory.txt");
		await writeFile(imagePath, LARGE_PNG);
		const stub = `#!/usr/bin/env node
import { dirname } from "node:path";
import { writeFileSync } from "node:fs";
const input = process.argv.slice(2).find(arg => arg.endsWith("input.img"));
writeFileSync(${JSON.stringify(captureLog)}, dirname(input));
process.exit(1);
`;
		for (const command of process.platform === "darwin" ? ["sips"] : ["magick", "convert"]) {
			const path = join(directory, command);
			await writeFile(path, stub);
			await chmod(path, 0o755);
		}
		process.env.PATH = directory + delimiter + (oldPath ?? "");
		assert.equal((await readImageFromPath(imagePath))?.image.data, LARGE_PNG.toString("base64"));
		assert.deepEqual(await readFile(imagePath), LARGE_PNG);
		await assert.rejects(stat(await readFile(captureLog, "utf8")), { code: "ENOENT" });
	} finally {
		if (oldPath === undefined) delete process.env.PATH;
		else process.env.PATH = oldPath;
		await rm(directory, { recursive: true, force: true });
	}
});

test("clipboard file paths with unquoted spaces are read without touching the real clipboard", {
	skip: process.platform !== "darwin" && process.platform !== "linux",
}, async () => {
	const directory = await mkdtemp(join(tmpdir(), "anti-trace-clipboard-test-"));
	const oldPath = process.env.PATH;
	try {
		const imagePath = join(directory, "clipboard raw image.png");
		const captureLog = join(directory, "capture-directory.txt");
		await writeFile(imagePath, PNG);
		const stub = `#!/usr/bin/env node
import { basename, dirname } from "node:path";
import { writeFileSync } from "node:fs";
const command = basename(process.argv[1]);
const args = process.argv.slice(2);
const imagePath = ${JSON.stringify(imagePath)};
if (command === "osascript") {
	if (args.some(arg => arg.includes("PNGf"))) {
		const statement = args.find(arg => arg.startsWith("set fp"));
		const literal = statement.match(/POSIX file (".*") with write permission/)[1];
		writeFileSync(${JSON.stringify(captureLog)}, dirname(JSON.parse(literal)));
		process.exit(1);
	}
	process.stdout.write(imagePath + "\\n");
} else if (args.includes("TARGETS") || args.includes("--list-types")) {
	process.stdout.write("text/plain\\n");
} else {
	process.stdout.write(imagePath + "\\n");
}
`;
		const commands = process.platform === "darwin" ? ["osascript", "pbpaste"] : ["xclip", "wl-paste"];
		for (const command of commands) {
			const path = join(directory, command);
			await writeFile(path, stub);
			await chmod(path, 0o755);
		}
		process.env.PATH = directory + delimiter + (oldPath ?? "");
		const result = await readClipboardImageAsync();
		assert.equal(result?.sourcePath, imagePath);
		assert.equal(result?.filename, "clipboard raw image.png");
		assert.equal(result?.image.data, PNG.toString("base64"));
		assert.deepEqual(await readFile(imagePath), PNG);
		if (process.platform === "darwin") {
			const captureDirectory = await readFile(captureLog, "utf8");
			await assert.rejects(stat(captureDirectory), { code: "ENOENT" });
		}
	} finally {
		if (oldPath === undefined) delete process.env.PATH;
		else process.env.PATH = oldPath;
		await rm(directory, { recursive: true, force: true });
	}
});
