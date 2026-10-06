import { PassThrough } from "node:stream";
import { createElement, type ReactNode } from "react";
import { render, Text } from "ink";
import { TerminalInputParser, type TerminalInputEvent } from "./terminal-input.ts";

const ENABLE_BRACKETED_PASTE = "\x1b[?2004h";
const DISABLE_BRACKETED_PASTE = "\x1b[?2004l";

export interface TerminalStreams {
	stdin: NodeJS.ReadStream;
	stdout: NodeJS.WriteStream;
}

export interface TerminalHost {
	rerender(tree: ReactNode): void;
	stop(): void;
}

/** Owns real stdin. Ink renders through a separate stream and never reads terminal input. */
export function startTerminalHost(
	onEvent: (event: TerminalInputEvent) => void,
	streams: TerminalStreams = { stdin: process.stdin, stdout: process.stdout },
	onStop?: () => void,
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
			inkStdin.destroy();
		} finally {
			try {
				stdout.write(DISABLE_BRACKETED_PASTE);
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
		stdout.write(ENABLE_BRACKETED_PASTE);
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
			stdout,
			exitOnCtrlC: false,
			patchConsole: false,
		});
	} catch (error) {
		stop();
		throw error;
	}

	return { rerender: ink.rerender, stop };
}
