import {
	hasImageFilePath, readClipboardImageAsync, readImageFromPath, splitImagePathParts,
	type PastedImage,
} from "../utils/image-paste.ts";
import type { RoutedInputEvent } from "./input-dispatcher.ts";

export const PASTE_THRESHOLD = 800;
export const PASTE_COMPLETION_TIMEOUT_MS = 100;

export interface PasteHandlerOptions {
	onInput: (event: RoutedInputEvent) => void;
	onPaste: (text: string) => void;
	onImagePaste?: (image: PastedImage) => void;
	onPendingChange?: (pending: boolean) => void;
	/** Delivery callback failures, rather than expected unreadable-image fallbacks. */
	onError?: (error: unknown) => void;
	readImage?: (path: string) => Promise<PastedImage | null>;
	readClipboard?: () => Promise<PastedImage | null>;
	platform?: NodeJS.Platform;
}

type PasteJob =
	| { type: "text"; text: string }
	| { type: "clipboard" }
	| { type: "action"; run: () => void };

/** Parsed events in, ordered text/image callbacks out; no stdin or draft ownership. */
export class PasteHandler {
	private chunks: string[] | null = null;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private jobs: PasteJob[] = [];
	private running = false;
	private pending = false;
	private active = true;
	private generation = 0;

	constructor(private readonly options: PasteHandlerOptions) {}

	isPending = (): boolean => this.pending;

	/** Explicit paste wins; large blocks, paths and pending continuations use the same buffer. */
	handleInput(event: RoutedInputEvent): void {
		if (!this.active) return;
		// Empty image paste must stay separate from text typed immediately afterwards.
		if (event.type === "paste" && event.text.length === 0
			&& this.platform() === "darwin" && this.options.onImagePaste) {
			this.pasteClipboard();
			return;
		}
		const text = printableText(event);
		if (text === null) {
			this.options.onInput(event);
			return;
		}
		if (event.type === "paste" || text.length > PASTE_THRESHOLD || this.pending || hasImageFilePath(text)) {
			(this.chunks ??= []).push(text);
			if (this.timer) clearTimeout(this.timer);
			this.timer = setTimeout(() => {
				this.timer = undefined;
				this.flush();
			}, PASTE_COMPLETION_TIMEOUT_MS);
			// Set before returning to the dispatcher's next event in this stdin batch.
			this.publishPending();
		} else {
			this.options.onInput(event);
		}
	}

	/** Editing follows the paste it arrived after; submission is gated by the caller. */
	runAfterPaste(run: () => void): void {
		if (!this.active) return;
		if (!this.pending) { run(); return; }
		this.sealBuffer();
		this.jobs.push({ type: "action", run });
		this.drain();
	}

	pasteClipboard(): void {
		if (!this.active || !this.options.onImagePaste) return;
		this.sealBuffer();
		this.jobs.push({ type: "clipboard" });
		this.publishPending();
		this.drain();
	}

	/** Also used to finish text immediately before an editing action. */
	flush(): void {
		if (!this.active) return;
		this.sealBuffer();
		this.drain();
	}

	/** New draft/session: old timers and in-flight readers can no longer deliver callbacks. */
	cancel(): void {
		this.generation++;
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
		this.chunks = null;
		this.jobs = [];
		this.running = false;
		this.publishPending();
	}

	dispose(): void {
		if (!this.active) return;
		this.active = false;
		this.cancel();
	}

	private sealBuffer(): void {
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
		if (this.chunks === null) return;
		this.jobs.push({ type: "text", text: this.chunks.join("") });
		this.chunks = null;
	}

	private drain(): void {
		if (this.running || !this.active) return;
		const generation = this.generation;
		try {
			if (this.jobs.length === 0) { this.publishPending(); return; }
			this.running = true;
			this.publishPending();
			while (this.jobs.length > 0 && this.isCurrent(generation)) {
				const job = this.jobs.shift()!;
				let work: Promise<void> | undefined;
				if (job.type === "action") job.run();
				else if (job.type === "clipboard") work = this.deliverClipboard(generation);
				else if (this.options.onImagePaste && (hasImageFilePath(job.text)
					|| (job.text.length === 0 && this.platform() === "darwin"))) {
					work = this.deliverImages(job.text, generation);
				} else this.options.onPaste(job.text);
				if (work) {
					void work.then(() => {
						if (!this.isCurrent(generation)) return;
						this.running = false;
						this.drain();
					}).catch(error => this.fail(error, generation));
					return;
				}
			}
			if (this.isCurrent(generation)) {
				this.running = false;
				this.publishPending();
			}
		} catch (error) {
			this.fail(error, generation);
		}
	}

	private async deliverImages(text: string, generation: number): Promise<void> {
		if (text.length === 0) { await this.deliverClipboard(generation); return; }
		const parts = splitImagePathParts(text);
		const results = await Promise.all(parts.map(async part => {
			if (!part.path) return null;
			let image = await this.readImage(part.path);
			if (!this.isCurrent(generation)) return null;
			if (!image && this.platform() === "darwin"
				&& /\/TemporaryItems\/.*screencaptureui.*\/Screenshot/i.test(part.path)) {
				image = await this.readClipboard();
			}
			return image;
		}));
		let remainingText = "";
		for (let index = 0; index < parts.length && this.isCurrent(generation); index++) {
			const image = results[index];
			if (!image) { remainingText += parts[index]!.text; continue; }
			if (remainingText) this.options.onPaste(remainingText);
			remainingText = "";
			if (this.isCurrent(generation)) this.options.onImagePaste!(image);
		}
		if (remainingText && this.isCurrent(generation)) this.options.onPaste(remainingText);
	}

	private async deliverClipboard(generation: number): Promise<void> {
		const image = await this.readClipboard();
		if (image && this.isCurrent(generation)) this.options.onImagePaste?.(image);
	}

	private async readImage(path: string): Promise<PastedImage | null> {
		try { return await (this.options.readImage ?? readImageFromPath)(path); }
		catch { return null; }
	}

	private async readClipboard(): Promise<PastedImage | null> {
		try { return await (this.options.readClipboard ?? readClipboardImageAsync)(); }
		catch { return null; }
	}

	private platform(): NodeJS.Platform { return this.options.platform ?? process.platform; }
	private isCurrent(generation: number): boolean { return this.active && generation === this.generation; }

	private publishPending(): void {
		const pending = this.chunks !== null || this.running || this.jobs.length > 0;
		if (pending === this.pending) return;
		this.pending = pending;
		this.options.onPendingChange?.(pending);
	}

	private fail(error: unknown, generation: number): void {
		if (!this.isCurrent(generation)) return;
		let reported = error;
		try { this.cancel(); }
		catch (cleanupError) { reported = new AggregateError([error, cleanupError], "Paste delivery and cleanup failed"); }
		if (this.options.onError) {
			try { this.options.onError(reported); }
			catch (reportError) { queueMicrotask(() => { throw reportError; }); }
		} else queueMicrotask(() => { throw reported; });
	}
}

function printableText(event: RoutedInputEvent): string | null {
	if (event.type !== "key") return event.text;
	return event.text && !event.ctrl && !event.alt && !event.meta
		&& !/[\u0000-\u001f\u007f-\u009f]/u.test(event.text) ? event.text : null;
}
