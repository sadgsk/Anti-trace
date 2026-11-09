import { startTerminalHost, type TerminalHost, type TerminalStreams } from "../ink/terminal-host.ts";
import { InputDispatcher, type InputTarget } from "../input/input-dispatcher.ts";
import { REPL_KEYBINDINGS, type Keybinding } from "../input/keybindings.ts";
import { PromptInputController } from "../input/prompt-input-controller.ts";
import type { TextInputOptions } from "../input/text-input-controller.ts";
import { ReplController, type ReplHarness } from "./repl-controller.ts";
import type { ByokRuntime } from "../byok-runtime.ts";
import { PromptSuggestionsController } from "../../tui/suggestions/prompt-suggestions-controller.ts";
import { ReplScreen } from "../../tui/layout/ReplScreen.tsx";
import { ThemeProvider } from "../../tui/theme/ThemeProvider.tsx";
import { detectColorDepth } from "../../tui/theme/color.ts";
import { FocusStack, FocusStackProvider } from "../../tui/focus/focus-stack.tsx";
import type { PermissionMode } from "../permissions/permission-policy.ts";
import { LocaleProvider } from "../../tui/locale/LocaleProvider.tsx";
import { mouseWheelDirection } from "../ink/mouse-wheel.ts";
import type { TranscriptFrame } from "../../tui/layout/TranscriptViewport.tsx";
import type { UiLocale } from "../locale.ts";
import { ArrayRows, appendRows, overlayTail } from "../../tui/layout/terminal-rows.ts";

export interface TerminalReplOptions {
	harness: ReplHarness;
	byok?: ByokRuntime;
	startupMessage?: string;
	streams?: TerminalStreams;
	pasteOptions?: TextInputOptions["pasteOptions"];
	bindings?: readonly Keybinding[];
	onExit?: () => void;
	cwd?: string;
	locale?: UiLocale;
	permissionMode?: PermissionMode;
}

/** One terminal host feeds draft actions and global REPL actions through one dispatcher. */
export function startTerminalRepl(options: TerminalReplOptions) {
	const streams = options.streams ?? { stdin: process.stdin, stdout: process.stdout };
	const columns = () => Math.max(1, (streams.stdout.columns || 80) - 1);
	const inputColumns = () => Math.max(1, columns() - 3);
	const cwd = options.cwd ?? process.cwd();
	let host: TerminalHost | undefined;
	let active = true;
	let resolveDone!: () => void;
	const done = new Promise<void>(resolve => { resolveDone = resolve; });
	let prompt!: PromptInputController;
	const repl = new ReplController({ harness: options.harness, byok: options.byok, cwd, locale: options.locale, interactive: true, permissionMode: options.permissionMode,
		onAccept: () => prompt.reset(), onExit: () => stop() });
	prompt = new PromptInputController({
		availableColumns: inputColumns(),
		pasteOptions: options.pasteOptions,
		canSubmit: () => repl.canSubmit(),
		onSubmit: draft => { void repl.submit(draft); },
		onPasteError: error => { repl.write(`粘贴失败：${error instanceof Error ? error.message : String(error)}`); },
	});
	const dispatcher = new InputDispatcher();
	const global: InputTarget = { id: Symbol("repl"), context: "Global", actions: {
		"app:interrupt": () => {
			if (repl.getSnapshot().busy) repl.interrupt();
			else if (repl.dialogs.getSnapshot()) repl.dialogs.cancel();
			else if (prompt.getDraft().text || prompt.textInput.pasteHandler.isPending()) prompt.reset();
			else if (repl.getSnapshot().resumeChoices) { void repl.submit(prompt.getDraft()); }
			else repl.exit();
		},
		"app:exit": () => repl.exit(),
		"app:expand": () => repl.toggleExpanded(),
		"app:permission-mode": () => repl.permissions.cycleMode(),
		"app:scroll-up": () => { host?.invalidate(); repl.scroll(Math.max(1, (streams.stdout.rows || 24) - 6)); },
		"app:scroll-down": () => { host?.invalidate(); repl.scroll(-Math.max(1, (streams.stdout.rows || 24) - 6)); },
		"app:scroll-latest": () => repl.returnToLatest(),
	} };
	const inputTarget: InputTarget = { ...prompt.target, actions: {
		...prompt.target.actions,
		"app:exit": () => repl.exit(),
	} };
	const suggestions = new PromptSuggestionsController(prompt, repl, { cwd });
	repl.permissions.feedback.setAvailableColumns(Math.max(1, columns() - 5));
	const focus = new FocusStack(dispatcher, options.bindings ?? REPL_KEYBINDINGS);
	focus.set("global", global); focus.set("editor", inputTarget);
	let menuOpen = false;
	const configureTargets = () => { const open = suggestions.getSnapshot().open; if (open !== menuOpen) { host?.invalidate(); menuOpen = open; } focus.set("suggestion", suggestions.target, open); };
	const unsubscribeSuggestions = suggestions.subscribe(configureTargets);
	const configurePermission = () => { host?.invalidate(); focus.set("modal", repl.permissions.target, Boolean(repl.permissions.getSnapshot().request)); };
	const unsubscribePermission = repl.permissions.subscribe(configurePermission);
	const configureDialog = () => { host?.invalidate(); focus.set("modal", repl.dialogs.target, Boolean(repl.dialogs.getSnapshot())); };
	const unsubscribeDialog = repl.dialogs.subscribe(configureDialog);
	repl.dialogs.setColumns(columns());
	configureTargets();
	let epoch = repl.getSnapshot().renderEpoch;
	let historyVersion = repl.getSnapshot().historyVersion;
	let reviewing = repl.getSnapshot().viewingHistory;
	const unsubscribeRepl = repl.subscribe(() => {
		if (reviewing !== repl.getSnapshot().viewingHistory) { reviewing = repl.getSnapshot().viewingHistory; host?.invalidate(); }
		if (repl.getSnapshot().historyVersion !== historyVersion) { historyVersion = repl.getSnapshot().historyVersion; queueMicrotask(() => { if (active) { host?.beginHistory(); renderView(); } }); }
		if (repl.getSnapshot().renderEpoch !== epoch) { epoch = repl.getSnapshot().renderEpoch; host?.invalidate(); }
	});
	let layoutSize = { columns: columns(), rows: streams.stdout.rows || 24 };
	let transcriptFrame: TranscriptFrame | undefined;
	const onTranscriptFrame = (frame?: TranscriptFrame) => { transcriptFrame = frame; };
	const isConversation = () => !repl.dialogs.getSnapshot() && !repl.permissions.getSnapshot().request && !suggestions.getSnapshot().open && !repl.getSnapshot().viewingHistory && repl.getSnapshot().scrollOffset === 0;
	const tree = () => { layoutSize = { columns: columns(), rows: streams.stdout.rows || 24 }; return <ThemeProvider depth={detectColorDepth(streams.stdout)}><LocaleProvider locale={repl.locale}><FocusStackProvider stack={focus}>
		<ReplScreen repl={repl} prompt={prompt} suggestions={suggestions} cwd={cwd} columns={columns()} rows={streams.stdout.rows || 24} nativeScrollback onTranscriptFrame={onTranscriptFrame} />
	</FocusStackProvider></LocaleProvider></ThemeProvider>; };
	const renderView = () => host?.rerender(tree());
	const resize = () => {
		host?.reflow();
		prompt.setAvailableColumns(inputColumns());
		repl.permissions.feedback.setAvailableColumns(Math.max(1, columns() - 5));
		repl.dialogs.setColumns(columns());
		renderView();
	};
	const cleanup = () => {
		if (!active) return;
		active = false;
		streams.stdout.off("resize", resize);
		unsubscribeSuggestions();
		unsubscribePermission();
		unsubscribeDialog();
		unsubscribeRepl();
		suggestions.dispose();
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
		if (options.startupMessage) repl.write(options.startupMessage);
		repl.writeContext();
		host = startTerminalHost(event => {
			if (event.type === "mouse") {
				const direction = mouseWheelDirection(event.raw);
				if (direction && !repl.dialogs.getSnapshot() && !repl.permissions.getSnapshot().request && !suggestions.getSnapshot().open) { host?.invalidate(); repl.scroll(direction * 3); }
				return;
			}
			dispatcher.dispatch(event);
		}, streams, cleanup, { scrollback: true, mouseWheel: true,
			layoutSize: () => layoutSize,
			frameRows: frame => {
				const rows = frame.replace(/\n$/, "").split("\n");
				if (repl.dialogs.getSnapshot() || repl.permissions.getSnapshot().request) return new ArrayRows(rows);
				if (!transcriptFrame || transcriptFrame.columns !== columns() || transcriptFrame.native !== isConversation() || transcriptFrame.historyVersion !== repl.getSnapshot().historyVersion) return undefined;
				if (!transcriptFrame.native) return new ArrayRows(rows);
				const { rows: history, viewportRows } = transcriptFrame;
				return appendRows(overlayTail(history, rows.slice(0, viewportRows)), [...Array<string>(Math.max(0, viewportRows - history.length)).fill(""), ...rows.slice(viewportRows)]);
			},
			onFrameWritten: () => { if (isConversation()) transcriptFrame?.onWrite(); },
			isConversation });
		streams.stdout.on("resize", resize);
		renderView();
	} catch (error) {
		stop();
		throw error;
	}
	return { prompt, repl, suggestions, dispatcher, stop, done };
}
