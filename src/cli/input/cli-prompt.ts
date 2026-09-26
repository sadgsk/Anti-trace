import { stdin, stdout } from "node:process";
import type { WriteStream } from "node:tty";
import { isImagePasteKey } from "../utils/image.ts";
import { CliRenderer } from "./cli-renderer.ts";
import { DraftEditor } from "./draft.ts";
import { PasteBurst, type BurstOutput } from "./paste-burst.ts";
import { TerminalInput, type TerminalInputEvent, type TerminalInputStream } from "./terminal.ts";

export type PromptResult =
	| { type: "submit"; text: string }
	| { type: "interrupt" }
	| { type: "end" };

export interface CliPromptOptions {
	input?: TerminalInputStream;
	output?: WriteStream;
	/** Returns a notice such as `[Image #1]` after reading the clipboard. */
	onImagePaste?: () => string;
}

type KeyEvent = Extract<TerminalInputEvent, { type: "key" }>;

/**
 * Temporary line-oriented CLI adapter. TerminalInput, PasteBurst, and DraftEditor
 * have no dependency on this renderer and can be reused by the future TUI.
 */
export class CliPrompt {
	readonly #input: TerminalInputStream;
	readonly #output: WriteStream;
	readonly #renderer: CliRenderer;
	readonly #editor = new DraftEditor();
	readonly #burst = new PasteBurst();
	readonly #onImagePaste?: () => string;
	#terminal: TerminalInput | undefined;
	#resolve: ((result: PromptResult) => void) | undefined;
	#timer: NodeJS.Timeout | undefined;
	#label = "";
	#pasteMode = false;
	#allowPasteMode = false;
	#sourceEnded = false;

	constructor(options: CliPromptOptions = {}) {
		this.#input = options.input ?? stdin;
		this.#output = options.output ?? stdout;
		this.#renderer = new CliRenderer(this.#output);
		this.#onImagePaste = options.onImagePaste;
	}

	read(label: string, options: { allowPasteMode?: boolean } = {}): Promise<PromptResult> {
		if (this.#resolve) {
			throw new Error("A prompt is already active");
		}
		if (this.#sourceEnded || this.#input.readableEnded) {
			return Promise.resolve({ type: "end" });
		}
		this.#label = label;
		this.#pasteMode = false;
		this.#allowPasteMode = options.allowPasteMode ?? false;
		this.#editor.setText("");
		this.#burst.reset();
		const result = new Promise<PromptResult>((resolve) => {
			this.#resolve = resolve;
		});
		this.#render();
		this.#terminal = new TerminalInput({
			input: this.#input,
			output: this.#output,
			onEvent: (event) => this.#handleEvent(event),
		});
		try {
			this.#terminal.start();
		} catch (error) {
			this.#close({ type: "end" });
			throw error;
		}
		return result;
	}

	dispose(): void {
		this.#terminal?.stop();
		this.#terminal = undefined;
		this.#clearTimer();
		if (this.#resolve) {
			this.#close({ type: "end" });
		}
		this.#renderer.dispose();
	}

	#handleEvent(event: TerminalInputEvent): void {
		if (!this.#resolve) return;
		const now = Date.now();
		switch (event.type) {
			case "text":
				this.#applyBurst(this.#burst.feedText(event.text, now));
				this.#scheduleFlush();
				return;
			case "paste":
				this.#applyBurst(this.#burst.flushAll(now));
				if (!this.#resolve) return;
				this.#burst.reset();
				this.#editor.insert(event.text);
				this.#render();
				return;
			case "key":
				this.#handleKey(event, now);
				return;
			case "end":
				this.#sourceEnded = true;
				if (this.#input.isTTY === true) {
					this.#burst.reset();
					this.#close({ type: "end" });
					return;
				}
				this.#applyBurst(this.#burst.flushAll(now));
				this.#close(this.#editor.text.length > 0
					? { type: "submit", text: this.#editor.submit() }
					: { type: "end" });
				return;
		}
	}

	#handleKey(event: KeyEvent, now: number): void {
		if (event.key === "ctrl-c") {
			this.#close({ type: "interrupt" });
			return;
		}
		if (event.key === "ctrl-d" && this.#pasteMode) {
			this.#applyBurst(this.#burst.flushAll(now));
			this.#pasteMode = false;
			this.#render();
			this.#notice("粘贴模式结束；检查草稿后按 Enter 发送");
			return;
		}
		if (event.key === "enter" && !event.shift && !event.ctrl && !event.alt && !this.#pasteMode) {
			this.#applyBurst(this.#burst.feedDelimiter("enter", now));
			this.#scheduleFlush();
			return;
		}
		if (event.key === "tab" && !event.shift && !event.ctrl && !event.alt) {
			this.#applyBurst(this.#burst.feedDelimiter("tab", now));
			this.#scheduleFlush();
			return;
		}
		this.#applyBurst(this.#burst.flushAll(now));
		this.#clearTimer();
		if (!this.#resolve) return;

		if (event.key === "enter" || event.key === "ctrl-j") {
			this.#editor.newline();
		} else if (event.key === "ctrl-d") {
			if (this.#editor.text.length === 0) {
				this.#close({ type: "end" });
				return;
			}
			this.#editor.deleteForward();
		} else if (event.key === "backspace") {
			this.#editor.backspace();
		} else if (event.key === "delete") {
			this.#editor.deleteForward();
		} else if (event.key === "left") {
			this.#editor.moveLeft();
		} else if (event.key === "right") {
			this.#editor.moveRight();
		} else if (event.key === "home" || event.key === "ctrl-a") {
			this.#editor.moveHome();
		} else if (event.key === "end" || event.key === "ctrl-e") {
			this.#editor.moveEnd();
		} else if (event.key === "up" || event.key === "page-up") {
			if (!this.#editor.moveUp()) this.#editor.previousHistory();
		} else if (event.key === "down" || event.key === "page-down") {
			if (!this.#editor.moveDown()) this.#editor.nextHistory();
		} else if (event.key === "ctrl-u") {
			const start = this.#editor.text.lastIndexOf("\n", this.#editor.cursor - 1) + 1;
			this.#replaceRange(start, this.#editor.cursor);
		} else if (event.key === "ctrl-k") {
			const next = this.#editor.text.indexOf("\n", this.#editor.cursor);
			const end = next < 0 ? this.#editor.text.length : next === this.#editor.cursor ? next + 1 : next;
			this.#replaceRange(this.#editor.cursor, end);
		} else if (event.key === "ctrl-w") {
			this.#deletePreviousWord();
		} else if (event.key === "ctrl-l") {
			this.#renderer.clear();
		} else if (event.key === "ctrl-v" || event.key === "alt-v") {
			this.#handleImageKey(event);
		} else if (event.key === "tab") {
			this.#editor.insert("\t");
		}
		this.#render();
	}

	#applyBurst(events: BurstOutput[]): void {
		for (const event of events) {
			if (!this.#resolve) return;
			if (event.type === "key") {
				if (event.key === "enter") {
					if (this.#allowPasteMode && this.#editor.text === "/paste") {
						this.#editor.setText("");
						this.#pasteMode = true;
						this.#render();
						this.#notice("粘贴模式：换行只进入草稿，按 Ctrl+D 结束粘贴模式");
					} else {
						this.#close({ type: "submit", text: this.#editor.submit() });
					}
				} else {
					this.#editor.insert("\t");
					this.#render();
				}
			} else {
				this.#editor.insert(event.text);
				this.#render();
			}
		}
	}

	#scheduleFlush(): void {
		this.#clearTimer();
		const deadline = this.#burst.deadline;
		if (!this.#resolve || deadline === undefined) return;
		this.#timer = setTimeout(() => {
			this.#timer = undefined;
			this.#applyBurst(this.#burst.flushIfDue(Date.now()));
			this.#scheduleFlush();
		}, Math.max(1, deadline - Date.now() + 1));
	}

	#clearTimer(): void {
		if (this.#timer) {
			clearTimeout(this.#timer);
			this.#timer = undefined;
		}
	}

	#handleImageKey(event: KeyEvent): void {
		if (!this.#onImagePaste || !isImagePasteKey({
		name: "v",
		ctrl: event.key === "ctrl-v",
		meta: event.key === "alt-v",
		shift: event.shift,
		})) return;
		try {
			this.#notice(this.#onImagePaste());
		} catch (error) {
			this.#notice(error instanceof Error ? error.message : String(error));
		}
	}

	#replaceRange(start: number, end: number): void {
		if (start >= end) return;
		const text = this.#editor.text;
		this.#editor.setText(text.slice(0, start) + text.slice(end));
		this.#editor.setCursor(start);
	}

	#deletePreviousWord(): void {
		const before = this.#editor.text.slice(0, this.#editor.cursor);
		const parts = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(before)];
		let index = parts.length;
		while (index > 0 && /\s/u.test(parts[index - 1]!.segment)) index -= 1;
		while (index > 0 && !/\s/u.test(parts[index - 1]!.segment)) index -= 1;
		this.#replaceRange(parts[index]?.index ?? before.length, this.#editor.cursor);
	}

	#render(): void {
		if (this.#output.isTTY) {
			this.#renderer.show(this.#pasteMode ? "paste> " : this.#label, this.#editor.text, this.#editor.cursor);
		}
	}

	#notice(message: string): void {
		if (this.#output.isTTY) this.#renderer.print(message);
		else this.#output.write(`${message}\n`);
	}

	#close(result: PromptResult): void {
		const resolve = this.#resolve;
		if (!resolve) return;
		this.#resolve = undefined;
		this.#clearTimer();
		this.#terminal?.stop();
		this.#terminal = undefined;
		if (this.#output.isTTY) this.#renderer.finish();
		resolve(result);
	}
}
