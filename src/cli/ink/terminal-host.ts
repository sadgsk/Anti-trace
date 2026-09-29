import { PassThrough } from "node:stream";
import { createElement, type ReactNode } from "react";
import { render, Text } from "ink";

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
	onChunk: (chunk: Buffer) => void,
	streams: TerminalStreams = { stdin: process.stdin, stdout: process.stdout },
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
	let active = false;
	let ink: ReturnType<typeof render> | undefined;

	const stop = (): void => {
		if (!active) return;
		active = false;
		process.off("SIGINT", onSigint);
		process.off("SIGTERM", onSigterm);
		process.off("exit", stop);
		stdin.off("data", onChunk);
		stdin.pause();
		try {
			ink?.unmount();
			ink?.cleanup();
			inkStdin.destroy();
		} finally {
			try {
				stdout.write(DISABLE_BRACKETED_PASTE);
			} finally {
				if (!wasRaw) stdin.setRawMode(false);
			}
		}
	};
	const onSignal = (code: number): void => {
		stop();
		process.exit(code);
	};
	const onSigint = onSignal.bind(null, 130);
	const onSigterm = onSignal.bind(null, 143);

	try {
		if (!wasRaw) stdin.setRawMode(true);
		active = true;
		stdout.write(ENABLE_BRACKETED_PASTE);
		stdin.on("data", onChunk);
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
