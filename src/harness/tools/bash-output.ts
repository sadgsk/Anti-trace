import { randomUUID } from "node:crypto";
import { mkdir, open, unlink, type FileHandle } from "node:fs/promises";
import { join, resolve } from "node:path";

/** Raw output budget; metadata and the omission marker have a small additional cost. */
export const BASH_OUTPUT_MAX_BYTES = 32 * 1024;
const HEAD_BYTES = 8 * 1024;
const TAIL_BYTES = BASH_OUTPUT_MAX_BYTES - HEAD_BYTES;

export interface OutputByteRange { start: number; endExclusive: number }
export interface BashOutputSummary {
	truncated: boolean;
	totalBytes: number;
	returnedBytes: number;
	returnedByteRanges: OutputByteRange[];
	outputPath: string | null;
	totalLines: number;
}
export interface BashOutputSnapshot extends BashOutputSummary { text: string }

function newlines(buffer: Buffer): number {
	let count = 0;
	for (const byte of buffer) if (byte === 10) count++;
	return count;
}
const continuationByte = (byte: number) => (byte & 0xc0) === 0x80;

/** append() is serialized by the shell's Writable, whose backpressure bounds pending writes. */
export class BashOutput {
	private inline: Buffer[] = [];
	private head = Buffer.alloc(0);
	private tail = Buffer.alloc(0);
	private file?: FileHandle;
	private path: string | null = null;
	private pending: Promise<void> = Promise.resolve();
	totalBytes = 0;
	private newlineCount = 0;

	constructor(private readonly cwd: string) {}

	append(chunk: Buffer): Promise<void> {
		this.pending = this.write(chunk);
		return this.pending;
	}

	private async write(chunk: Buffer): Promise<void> {
		this.totalBytes += chunk.length;
		this.newlineCount += newlines(chunk);
		// Keep lookahead/lookbehind so UTF-8 cuts can move to a character boundary.
		if (this.head.length < HEAD_BYTES + 3) {
			this.head = Buffer.concat([this.head, chunk.subarray(0, HEAD_BYTES + 3 - this.head.length)]);
		}
		const tailCapacity = TAIL_BYTES + 3;
		this.tail = chunk.length >= tailCapacity
			? Buffer.from(chunk.subarray(chunk.length - tailCapacity))
			: Buffer.concat([this.tail.subarray(Math.max(0, this.tail.length + chunk.length - tailCapacity)), chunk]);

		if (!this.file && this.totalBytes <= BASH_OUTPUT_MAX_BYTES) {
			this.inline.push(Buffer.from(chunk));
			return;
		}
		try {
			if (!this.file) {
				const directory = resolve(this.cwd, ".ant-trace", "tool-results");
				await mkdir(directory, { recursive: true });
				const path = join(directory, `${randomUUID()}.log`);
				this.file = await open(path, "wx", 0o600);
				this.path = path;
				for (const buffered of this.inline) await this.file.writeFile(buffered);
				this.inline = [];
			}
			await this.file.writeFile(chunk);
		} catch (error) {
			throw new Error(`Could not save complete bash output: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
		}
	}

	async finish(): Promise<BashOutputSnapshot> {
		await this.pending;
		await this.close();
		const totalLines = this.totalBytes === 0 ? 0 : this.newlineCount + 1;
		if (this.totalBytes <= BASH_OUTPUT_MAX_BYTES) {
			return { text: Buffer.concat(this.inline).toString("utf8"), truncated: false,
				totalBytes: this.totalBytes, returnedBytes: this.totalBytes,
				returnedByteRanges: this.totalBytes ? [{ start: 0, endExclusive: this.totalBytes }] : [],
				outputPath: null, totalLines };
		}
		let headEnd = HEAD_BYTES;
		while (headEnd > 0 && continuationByte(this.head[headEnd]!)) headEnd--;
		let tailStart = Math.max(0, this.tail.length - TAIL_BYTES);
		while (tailStart < this.tail.length && continuationByte(this.tail[tailStart]!)) tailStart++;
		const head = this.head.subarray(0, headEnd), tail = this.tail.subarray(tailStart);
		const tailOffset = this.totalBytes - tail.length;
		const tailLine = this.newlineCount - newlines(tail) + 1;
		return { text: `${head.toString("utf8")}\n\n[Output truncated: bytes [${headEnd}, ${tailOffset}) omitted. Tail starts at line ${tailLine}.]\n\n${tail.toString("utf8")}`,
			truncated: true, totalBytes: this.totalBytes, returnedBytes: head.length + tail.length,
			returnedByteRanges: [{ start: 0, endExclusive: headEnd }, { start: tailOffset, endExclusive: this.totalBytes }],
			outputPath: this.path, totalLines };
	}

	private async close(): Promise<void> {
		const file = this.file;
		this.file = undefined;
		await file?.close();
	}

	/** On I/O/spawn failure, close any in-flight write and remove the incomplete log. */
	async discard(): Promise<void> {
		await this.pending.catch(() => {});
		try { await this.close(); }
		finally { if (this.path) await unlink(this.path).catch(() => {}); }
	}
}
