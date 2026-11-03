import { PassThrough, Writable } from "node:stream";
import { createElement, type ReactNode } from "react";
import { render, Text } from "ink";
import { TerminalInputParser, type TerminalInputEvent } from "./terminal-input.ts";
import { ScrollbackOutput } from "./scrollback-output.ts";

const ENABLE_BRACKETED_PASTE = "\x1b[?2004h";
const DISABLE_BRACKETED_PASTE = "\x1b[?2004l";

export interface TerminalStreams {
	stdin: NodeJS.ReadStream;
	stdout: NodeJS.WriteStream;
}

export interface TerminalHost {
	rerender(tree: ReactNode): void;
	invalidate(): void;
	beginHistory(): void;
	reflow(): void;
	stop(): void;
}

/** Owns real stdin. Ink renders through a separate stream and never reads terminal input. */
export function startTerminalHost(
	onEvent: (event: TerminalInputEvent) => void,
	streams: TerminalStreams = { stdin: process.stdin, stdout: process.stdout },
	onStop?: () => void,
	options: { fullScreen?: boolean; scrollback?: boolean; mouseWheel?: boolean; isConversation?: () => boolean; layoutSize?: () => { columns: number; rows: number } } = {},
): TerminalHost {
	const { stdin, stdout } = streams;
	if (!stdin.isTTY || !stdout.isTTY || typeof stdin.setRawMode !== "function") {
		throw new Error("TerminalHost requires an interactive TTY");
	}
	if (stdin.readableEncoding !== null) {
		throw new Error("TerminalHost requires undecoded stdin bytes");
	}

	const wasRaw = stdin.isRaw === true;
	const inkStdin = new PassThrough();
	const parser = new TerminalInputParser();
	const output = options.scrollback ? new ScrollbackOutput(stdout, options.isConversation) : undefined;
	// Frames are coalesced per tick; see the write callback below.
	let pendingFrame: string | undefined;
	let flushTimer: NodeJS.Immediate | undefined;
	const flushFrame = (): void => {
		if (flushTimer) clearImmediate(flushTimer);
		flushTimer = undefined;
		const frame = pendingFrame;
		pendingFrame = undefined;
		if (frame !== undefined) output?.write(frame);
	};
	const inkStdout = output ? Object.defineProperties(new Writable({ write(chunk, _encoding, done) {
		const layout = options.layoutSize?.(), frame = chunk.toString();
		// A leaf animation can render between the terminal resize and the root's resize handler.
		// Ignore that stale frame; it uses the old wrapping and could overwrite uncommitted history.
		// Cursor visibility toggles are not frames and must not replace a pending frame.
		if (frame && !/^\x1b\[\?25[hl]$/.test(frame) && (!layout || (layout.columns === Math.max(1, (stdout.columns || 80) - 1) && layout.rows === (stdout.rows || 24)))) {
			// Debug-mode Ink writes every commit, including one a layout effect corrects synchronously
			// (e.g. the viewport offset). Paint only the latest frame of each tick so stale frames never flash.
			pendingFrame = frame;
			flushTimer ??= setImmediate(flushFrame);
		}
		done();
	} }), {
		columns: { get: () => stdout.columns || 80 }, rows: { get: () => stdout.rows || 24 }, isTTY: { value: true },
	}) as NodeJS.WriteStream : stdout;
	let escapeTimer: NodeJS.Timeout | undefined;
	let active = false;
	let ink: ReturnType<typeof render> | undefined;
	const emitEvents = (events: readonly TerminalInputEvent[]): void => {
		try {
			for (const event of events) {
				// A submit/exit handler can stop the host while this byte batch is being delivered.
				if (!active) break;
				onEvent(event);
			}
		} catch (error) {
			stop();
			throw error;
		}
	};
	const handleData = (chunk: Buffer): void => {
		try {
			if (escapeTimer) clearTimeout(escapeTimer);
			escapeTimer = undefined;
			emitEvents(parser.feed(chunk));
			if (active && (parser.awaitingEscape || parser.awaitingPaste)) {
				escapeTimer = setTimeout(() => {
					escapeTimer = undefined;
					emitEvents(parser.feed(null));
				}, parser.awaitingPaste ? 500 : 50);
			}
		} catch (error) {
			stop();
			throw error;
		}
	};

	const stop = (): void => {
		if (!active) return;
		active = false;
		if (escapeTimer) clearTimeout(escapeTimer);
		escapeTimer = undefined;
		process.off("SIGINT", onSigint);
		process.off("SIGTERM", onSigterm);
		process.off("exit", stop);
		stdin.off("data", handleData);
		stdin.off("end", stop);
		stdin.off("close", stop);
		stdin.off("error", onInputError);
		stdin.pause();
		try {
			ink?.unmount();
			ink?.cleanup();
			flushFrame();
			output?.finish();
			if (output) inkStdout.destroy();
			inkStdin.destroy();
		} finally {
			try {
				stdout.write(DISABLE_BRACKETED_PASTE);
				if (options.mouseWheel) stdout.write("\x1b[?1000l\x1b[?1006l");
				if (options.fullScreen) stdout.write("\x1b[?1049l");
			} finally {
				try { if (!wasRaw) stdin.setRawMode(false); }
				finally { onStop?.(); }
			}
		}
	};
	const onSignal = (code: number): void => {
		stop();
		process.exit(code);
	};
	const onSigint = onSignal.bind(null, 130);
	const onSigterm = onSignal.bind(null, 143);
	const onInputError = (error: Error): void => {
		stop();
		throw error;
	};

	try {
		if (!wasRaw) stdin.setRawMode(true);
		active = true;
		if (options.fullScreen) stdout.write("\x1b[?1049h\x1b[H");
		stdout.write(ENABLE_BRACKETED_PASTE);
		if (options.mouseWheel) stdout.write("\x1b[?1000h\x1b[?1006h");
		stdin.on("data", handleData);
		stdin.once("end", stop);
		stdin.once("close", stop);
		stdin.once("error", onInputError);
		stdin.resume();
		process.once("SIGINT", onSigint);
		process.once("SIGTERM", onSigterm);
		process.once("exit", stop);
		ink = render(createElement(Text, null, ""), {
			stdin: inkStdin as unknown as NodeJS.ReadStream,
			stdout: inkStdout,
			debug: Boolean(output),
			exitOnCtrlC: false,
			patchConsole: false,
		});
	} catch (error) {
		stop();
		throw error;
	}

	return {
		rerender: tree => { if (active) ink?.rerender(tree); },
		invalidate: () => output?.invalidate(),
		beginHistory: () => output?.beginHistory(),
		reflow: () => output?.reflow(),
		stop,
	};
}
