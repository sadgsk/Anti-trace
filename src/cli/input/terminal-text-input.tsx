import { startTerminalHost, type TerminalHost, type TerminalStreams } from "../ink/terminal-host.ts";
import { BaseTextInput } from "./base-text-input.tsx";
import { InputDispatcher, type InputTarget } from "./input-dispatcher.ts";
import { DEFAULT_KEYBINDINGS, type Keybinding } from "./keybindings.ts";
import { TextInputController, type TextInputOptions } from "./text-input-controller.ts";

export interface TerminalTextInputOptions extends Omit<TextInputOptions, "availableColumns"> {
	outerTargets?: readonly InputTarget[];
	bindings?: readonly Keybinding[];
}

/** Standalone base input wiring; the REPL chooses when to mount it and accepts snapshots. */
export function startTerminalTextInput(
	options: TerminalTextInputOptions,
	streams: TerminalStreams = { stdin: process.stdin, stdout: process.stdout },
) {
	const columns = () => Math.max(1, (streams.stdout.columns || 80) - 1);
	const controller = new TextInputController({
		...options, availableColumns: columns(),
		onPasteError: error => {
			stop();
			if (options.onPasteError) options.onPasteError(error);
			else queueMicrotask(() => { throw error; });
		},
	});
	const dispatcher = new InputDispatcher();
	dispatcher.configure([controller.target, ...options.outerTargets ?? []], options.bindings ?? DEFAULT_KEYBINDINGS);
	let host: TerminalHost | undefined;
	const resize = () => controller.setAvailableColumns(columns());
	const cleanup = () => {
		streams.stdout.off("resize", resize);
		controller.dispose();
	};
	const stop = () => {
		try { host?.stop(); }
		finally { cleanup(); }
	};
	try {
		host = startTerminalHost(event => dispatcher.dispatch(event), streams, cleanup);
		streams.stdout.on("resize", resize);
		host.rerender(<BaseTextInput controller={controller} />);
	} catch (error) {
		stop();
		throw error;
	}
	return {
		controller,
		dispatcher,
		stop,
	};
}
