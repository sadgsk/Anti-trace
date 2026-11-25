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
import { ReplyGraphics, replyGraphicsQuery } from "../ink/reply-graphics.ts";
import { inputInset } from "../../tui/layout/PromptInputBox.tsx";
import { dialogLayout } from "../../tui/design-system/Pane.tsx";
import { logoHeight } from "../../tui/layout/brand-art.ts";
import { ReplyGraphicsContext } from "../../tui/messages/ReplyMark.tsx";
import { railInset } from "../../tui/messages/MessageFrame.tsx";

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
	const graphics = new ReplyGraphics();
	const probeGraphics = process.env.TERM !== "dumb" && process.env.NO_COLOR === undefined;
	const columns = () => Math.max(1, (streams.stdout.columns || 80) - 1);
	const panel = () => dialogLayout(columns(), streams.stdout.rows || 24);
	const inputColumns = () => Math.max(1, columns() - inputInset(columns()) - 1);
	const cwd = options.cwd ?? process.cwd();
	let host: TerminalHost | undefined;
	let active = true;
	let resolveDone!: (code: number) => void;
	let rejectDone!: (error: unknown) => void;
	const done = new Promise<number>((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
	let prompt!: PromptInputController;
	const repl = new ReplController({ harness: options.harness, byok: options.byok, cwd, locale: options.locale, interactive: true, permissionMode: options.permissionMode,
		onAccept: () => prompt.reset(), getDraftEditor: () => prompt, onExit: () => stop() });
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
		"app:permission-mode": () => {
			repl.permissions.cycleMode();
			repl.write(repl.locale.t("权限模式") + " · " + repl.permissions.getSnapshot().mode);
		},
		"app:scroll-up": () => { host?.invalidate(); repl.scroll(Math.max(1, (streams.stdout.rows || 24) - 6)); },
		"app:scroll-down": () => { host?.invalidate(); repl.scroll(-Math.max(1, (streams.stdout.rows || 24) - 6)); },
		"app:scroll-latest": () => repl.returnToLatest(),
	} };
	const inputTarget: InputTarget = { ...prompt.target, actions: {
		...prompt.target.actions,
		"app:exit": () => repl.exit(),
	} };
	const suggestions = new PromptSuggestionsController(prompt, repl, { cwd });
	const focus = new FocusStack(dispatcher, options.bindings ?? REPL_KEYBINDINGS);
	focus.set("global", global); focus.set("editor", inputTarget);
	let menuOpen = false;
	const configureTargets = () => { const open = suggestions.getSnapshot().open; if (open !== menuOpen) { host?.invalidate(); menuOpen = open; } focus.set("suggestion", suggestions.target, open); };
	const unsubscribeSuggestions = suggestions.subscribe(configureTargets);
	const configureModal = () => {
		host?.invalidate();
		const permission = Boolean(repl.permissions.getSnapshot().request);
		focus.set("modal", repl.dialogs.target, !permission && Boolean(repl.dialogs.getSnapshot()));
		focus.set("modal", repl.permissions.target, permission);
	};
	const unsubscribePermission = repl.permissions.subscribe(configureModal);
	const unsubscribeDialog = repl.dialogs.subscribe(configureModal);
	repl.dialogs.setColumns(panel().width);
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
	const tree = () => { layoutSize = { columns: columns(), rows: streams.stdout.rows || 24 }; return <ThemeProvider depth={detectColorDepth(streams.stdout)} paper={graphics.background}><LocaleProvider locale={repl.locale}><FocusStackProvider stack={focus}>
		<ReplyGraphicsContext.Provider value={probeGraphics && graphics.available}><ReplScreen repl={repl} prompt={prompt} suggestions={suggestions} cwd={cwd} columns={columns()} rows={streams.stdout.rows || 24} nativeScrollback onTranscriptFrame={onTranscriptFrame} /></ReplyGraphicsContext.Provider>
	</FocusStackProvider></LocaleProvider></ThemeProvider>; };
	const renderView = () => host?.rerender(tree());
	const resize = () => {
		host?.reflow();
		if (probeGraphics) { const sixel = graphics.resize(); streams.stdout.write((sixel ? "\x1b[16t" : "") + "\x1b]11;?\x1b\\"); }
		prompt.setAvailableColumns(inputColumns());
		repl.dialogs.setColumns(panel().width);
		renderView();
	};
	const cleanup = (exitCode = 0) => {
		if (!active) return;
		active = false;
		streams.stdout.off("resize", resize);
		unsubscribeSuggestions();
		unsubscribePermission();
		unsubscribeDialog();
		unsubscribeRepl();
		suggestions.dispose();
		prompt.dispose();
		void repl.dispose().then(() => options.onExit?.()).then(() => resolveDone(exitCode), rejectDone);
	};
	function stop(): void {
		try { host?.stop(); }
		finally { cleanup(); }
	}
	try {
		if (options.startupMessage) repl.write(options.startupMessage);
		repl.writeContext();
		host = startTerminalHost(event => {
			if (event.type === "response" && probeGraphics) {
				const before = graphics.available, paper = graphics.background;
				graphics.response(event.raw);
				if (before !== graphics.available || paper !== graphics.background) renderView();
				return;
			}
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
				const permission = repl.permissions.getSnapshot().request;
				const dialog = repl.dialogs.getSnapshot();
				const modal = Boolean(dialog || permission);
				if (dialog && !permission && panel().position === "solo") return new ArrayRows(rows);
				if (!transcriptFrame || transcriptFrame.modal !== modal || transcriptFrame.columns !== columns() || transcriptFrame.native !== isConversation() || transcriptFrame.historyVersion !== repl.getSnapshot().historyVersion) return undefined;
				const { thinkingRow, viewportRows, brandColumns, logoOffset } = transcriptFrame;
				if (logoOffset !== undefined) {
					for (let i = 0; i < Math.min(viewportRows, logoHeight(brandColumns) - logoOffset); i++) {
						if (rows[i]) rows[i] = graphics.paintLogo(rows[i]!, logoOffset + i, brandColumns);
					}
				}
				if (thinkingRow !== undefined && rows[thinkingRow]) rows[thinkingRow] = graphics.paint(rows[thinkingRow]!);
				if (graphics.available) {
					const railColumn = railInset(brandColumns);
					const firstMessageRow = logoOffset === undefined ? 0 : Math.max(0, logoHeight(brandColumns) - logoOffset);
					for (let i = firstMessageRow; i < viewportRows && i < rows.length; i++) rows[i] = graphics.paintJunction(rows[i]!, railColumn);
				}
				if (!transcriptFrame.native) return new ArrayRows(rows);
				const history = transcriptFrame.rows;
				return appendRows(overlayTail(history, rows.slice(0, viewportRows)), rows.slice(viewportRows));
			},
			onFrameWritten: () => { if (isConversation()) transcriptFrame?.onWrite(); },
			isConversation });
		streams.stdout.on("resize", resize);
		if (probeGraphics) streams.stdout.write(replyGraphicsQuery);
		renderView();
	} catch (error) {
		stop();
		throw error;
	}
	return { prompt, repl, suggestions, dispatcher, stop, done };
}
