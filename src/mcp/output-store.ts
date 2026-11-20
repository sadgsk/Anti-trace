import { randomUUID } from "node:crypto";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { throwCancelled } from "./util.ts";

export interface McpAttachment {
	path: string;
	mimeType: string;
	bytes: number;
}

/** Only the host selects the filename. Publish a path after the entire write completes. */
export async function saveMcpOutput(directory: string, data: string | Buffer, mimeType: string, signal?: AbortSignal): Promise<McpAttachment> {
	throwCancelled(signal);
	const suffixes: Record<string, string> = { "text/plain": "txt", "application/json": "json", "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif", "image/webp": "webp", "audio/wav": "wav", "audio/mpeg": "mp3" };
	const path = join(directory, randomUUID() + "." + (Object.hasOwn(suffixes, mimeType) ? suffixes[mimeType] : "bin"));
	const temp = path + ".tmp";
	await mkdir(directory, { recursive: true, mode: 0o700 });
	try {
		await writeFile(temp, data, { flag: "wx", mode: 0o600, signal });
		throwCancelled(signal);
		await rename(temp, path);
	} finally {
		await unlink(temp).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
	}
	return { path, mimeType, bytes: Buffer.byteLength(data) };
}
