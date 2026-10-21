import { useSyncExternalStore } from "react";
import { Box, Static, Text } from "ink";
import { startTerminalHost, type TerminalHost, type TerminalStreams } from "../ink/terminal-host.ts";
import { InputDispatcher, type InputTarget } from "../input/input-dispatcher.ts";
import { REPL_KEYBINDINGS, type Keybinding } from "../input/keybindings.ts";
import { PromptInput } from "../input/prompt-input.tsx";
import { PromptInputController } from "../input/prompt-input-controller.ts";
import type { TextInputOptions } from "../input/text-input-controller.ts";
import { ReplController, type ReplHarness } from "./repl-controller.ts";
import type { ByokRuntime } from "../byok-runtime.ts";

export interface TerminalReplOptions {
	harness: ReplHarness;
	byok?: ByokRuntime;
	startupMessage?: string;
	streams?: TerminalStreams;
	pasteOptions?: TextInputOptions["pasteOptions"];
	bindings?: readonly Keybinding[];
	banner?: string;
	onExit?: () => void;
}

function displayText(text: string): string {
	return text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu, "�");
}

/** Ink owns both the streaming reply and draft display; no competing stdout writer. */
export function ReplView({ repl, prompt }: { repl: ReplController; prompt: PromptInputController }) {
	const state = useSyncExternalStore(repl.subscribe, repl.getSnapshot, repl.getSnapshot);
	return <Box flexDirection="column">
		<Static items={[...state.entries]}>{entry => <Text key={entry.id} dimColor={entry.kind === "thinking"}>{displayText(entry.text)}</Text>}</Static>
		{state.liveText ? <Text dimColor={state.liveKind === "thinking"}>{displayText(state.liveText)}</Text> : null}
		{state.closed ? null : <Box flexDirection="column">
			{state.modelStatus ? <Text dimColor>{displayText(state.modelStatus)}</Text> : null}
			{state.busy ? <Text dimColor>处理中，Ctrl+C 中断</Text> : null}
			<Text dimColor>{state.resumeChoices ? "会话序号（空行取消）" : ">"}</Text>
			<PromptInput controller={prompt} />
		</Box>}
	</Box>;
}

/** One terminal host feeds draft actions and global REPL actions through one dispatcher. */
export function startTerminalRepl(options: TerminalReplOptions) {
	const streams = options.streams ?? { stdin: process.stdin, stdout: process.stdout };
	const columns = () => Math.max(1, (streams.stdout.columns || 80) - 1);
	let host: TerminalHost | undefined;
	let active = true;
	let resolveDone!: () => void;
	const done = new Promise<void>(resolve => { resolveDone = resolve; });
	let prompt!: PromptInputController;
	const repl = new ReplController({ harness: options.harness, byok: options.byok, onAccept: () => prompt.reset(), onExit: () => stop() });
	prompt = new PromptInputController({
		availableColumns: columns(),
		pasteOptions: options.pasteOptions,
		canSubmit: () => repl.canSubmit(),
		onSubmit: draft => { void repl.submit(draft); },
		onPasteError: error => { repl.write(`粘贴失败：${error instanceof Error ? error.message : String(error)}`); },
	});
	const dispatcher = new InputDispatcher();
	const global: InputTarget = { id: Symbol("repl"), context: "Global", actions: {
		"app:interrupt": () => {
			if (repl.getSnapshot().busy) repl.interrupt();
			else if (prompt.getDraft().text || prompt.textInput.pasteHandler.isPending()) prompt.reset();
			else if (repl.getSnapshot().resumeChoices) { void repl.submit(prompt.getDraft()); }
			else repl.exit();
		},
		"app:exit": () => repl.exit(),
	} };
	const inputTarget: InputTarget = { ...prompt.target, actions: {
		...prompt.target.actions,
		"app:exit": () => repl.exit(),
	} };
	dispatcher.configure([inputTarget, global], options.bindings ?? REPL_KEYBINDINGS);
	const resize = () => prompt.setAvailableColumns(columns());
	const cleanup = () => {
		if (!active) return;
		active = false;
		streams.stdout.off("resize", resize);
		prompt.dispose();
		repl.dispose();
		resolveDone();
		options.onExit?.();
	};
	function stop(): void {
		try { host?.stop(); }
		finally { cleanup(); }
	}
	try {
		if (options.banner) repl.write(options.banner);
		if (options.startupMessage) repl.write(options.startupMessage);
		repl.write("/help 查看命令和快捷键。");
		repl.writeContext();
		host = startTerminalHost(event => dispatcher.dispatch(event), streams, cleanup);
		streams.stdout.on("resize", resize);
		host.rerender(<ReplView repl={repl} prompt={prompt} />);
	} catch (error) {
		stop();
		throw error;
	}
	return { prompt, repl, dispatcher, stop, done };
}
