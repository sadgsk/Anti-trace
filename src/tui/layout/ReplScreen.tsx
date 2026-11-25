import { useEffect, useLayoutEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Box } from "ink";
import type { ReplController } from "../../cli/repl/repl-controller.ts";
import type { PromptInputController } from "../../cli/input/prompt-input-controller.ts";
import { layoutTextInput } from "../../cli/input/text-input-layout.ts";
import type { PromptSuggestionsController } from "../suggestions/prompt-suggestions-controller.ts";
import { PromptSuggestions } from "../suggestions/PromptSuggestions.tsx";
import { layoutCommandMenu } from "../suggestions/command-menu-layout.ts";
import { dialogLayout } from "../design-system/Pane.tsx";
import { MessageFrame, frameContentColumns, railInset } from "../messages/MessageFrame.tsx";
import { hasLargeLogo, logoHeight, logoWidth } from "./brand-art.ts";
import { WelcomeHeader } from "./WelcomeHeader.tsx";
import { ThemedBox } from "../theme/ThemeProvider.tsx";
import { TokenWarning } from "./StatusLine.tsx";
import { PromptInputBox } from "./PromptInputBox.tsx";
import { layoutPermissionDialog, PermissionDialog } from "../permissions/PermissionDialog.tsx";
import { CommandDialog } from "../commands/CommandDialog.tsx";
import { TranscriptViewport, type TranscriptFrame } from "./TranscriptViewport.tsx";
import { useFrameSnapshot } from "./useFrameSnapshot.ts";
import { TranscriptLayoutCache } from "./TranscriptLayoutCache.tsx";
import type { TranscriptItem } from "../transcript.ts";
const ignoreModalMetrics = () => {};
export interface ReplScreenProps { repl: ReplController; prompt: PromptInputController; suggestions: PromptSuggestionsController; cwd: string; columns: number; rows: number; nativeScrollback?: boolean; onTranscriptFrame?: (frame?: TranscriptFrame) => void }
export function ReplScreen({ repl, prompt, suggestions, cwd, columns, rows, nativeScrollback = false, onTranscriptFrame }: ReplScreenProps) {
	const [openedAt, setOpenedAt] = useState(Date.now);
	const [cache] = useState(() => new TranscriptLayoutCache());
	useEffect(() => () => { setImmediate(() => cache.dispose()); }, [cache]);
	const state = useFrameSnapshot(repl.subscribe, repl.getSnapshot);
	const draft = useSyncExternalStore(prompt.subscribe, prompt.getSnapshot, prompt.getSnapshot);
	const menu = useSyncExternalStore(suggestions.subscribe, suggestions.getSnapshot, suggestions.getSnapshot);
	const permission = useSyncExternalStore(repl.permissions.subscribe, repl.permissions.getSnapshot, repl.permissions.getSnapshot);
	const dialog = useSyncExternalStore(repl.dialogs.subscribe, repl.dialogs.getSnapshot, repl.dialogs.getSnapshot);
	const modal = Boolean(permission.request || dialog);
	const commandOpen = Boolean(dialog && !permission.request);
	const thinking = state.busy && state.phase === "thinking";
	const compacting = state.busy && state.phase === "compacting";
	const { items, thinkingId } = useMemo(() => {
		const items = [...state.transcript, ...state.activeItems].filter(item => item.kind !== "assistant" || item.blocks.some(block => block.text));
		const last = items.at(-1);
		if (compacting) {
			const notice: TranscriptItem = { id: -2, kind: "notice", tone: "info", text: "压缩上下文中" };
			return { items: [...items, notice] };
		}
		if (!thinking) return { items };
		if (last?.kind === "assistant" && last.durationMs === undefined && last.blocks.at(-1)?.kind === "thinking") return { items, thinkingId: last.id };
		// Before the first reasoning delta, reserve a transient node at the same position as the forthcoming turn.
		const pending: TranscriptItem = { id: -1, kind: "assistant", timestamp: state.startedAt, blocks: [{ kind: "thinking", index: 0, text: " " }] };
		return { items: [...items, pending], thinkingId: pending.id };
	}, [state.transcript, state.activeItems, thinking, compacting, state.startedAt]);
	const screenRows = Math.max(1, rows - 1), maxEditorRows = Math.max(1, Math.min(6, Math.floor(rows / 4)));
	const editorRows = Math.min(maxEditorRows, layoutTextInput(draft.draft.text, draft.availableColumns).lines.length);
	const warning = Number(!!state.display.contextWindow && state.display.contextUsed / state.display.contextWindow >= 0.75);
	const draftRows = editorRows + Number(draft.draft.references.length > 0) + Number(draft.isPasting);
	const rules = columns >= 4 && screenRows >= draftRows + warning + 2;
	const showStatus = screenRows > draftRows + warning + (rules ? 2 : 0);
	const model = state.display.modelName === "模型未配置" ? "" : state.display.modelName;
	const inputRows = draftRows + (rules ? 2 : 0) + Number(showStatus);
	const menuRows = menu.open ? Math.max(0, Math.min(17, screenRows - inputRows - warning - Math.min(3, Math.floor(screenRows / 8)))) : 0;
	const panel = dialogLayout(columns, rows);
	const approvalAxis = railInset(columns);
	const approval = permission.request ? layoutPermissionDialog(permission, columns - approvalAxis, screenRows) : undefined;
	const stacked = commandOpen && panel.position === "stack";
	const sideWidth = !modal && menu.open && columns >= 72 && screenRows - inputRows - warning >= 10
		? Math.min(42, Math.max(30, Math.floor(columns / 3))) : 0;
	const dockWidth = commandOpen && panel.position === "side" ? panel.width : sideWidth;
	const transcriptColumns = dockWidth ? columns - dockWidth - 3 : columns;
	const menuColumns = sideWidth || frameContentColumns(columns);
	const menuLayout = menu.open ? layoutCommandMenu(menu, menuColumns, menuRows) : null;
	const usedMenuRows = menuLayout && !sideWidth ? (menuLayout.framed ? 4 : 0) + Number(menuLayout.footer) + Math.max(1, menuLayout.count) + Number(Boolean(menuLayout.more)) : 0;
	const footerRows = approval?.height ?? (commandOpen ? (stacked ? panel.height : 0) : inputRows + warning + usedMenuRows);
	const viewportRows = Math.max(0, screenRows - footerRows);
	const native = nativeScrollback && !state.viewingHistory && state.scrollOffset === 0 && !modal && !menu.open;
	// Opening a side panel should not resize the signature if its settled width still fits.
	const brandColumns = logoWidth(columns) <= transcriptColumns ? columns : transcriptColumns;
	const railOffset = railInset(brandColumns) - railInset(transcriptColumns);
	const largeLogo = hasLargeLogo(transcriptColumns, rows);
	const markRows = largeLogo ? logoHeight(brandColumns) : 1;
	const headerGap = viewportRows > markRows;
	const headerRows = markRows + Number(headerGap);
	const panelTop = dockWidth && items.length < 5 && viewportRows >= headerRows + (modal ? 16 : menuRows) ? headerRows : 0;
	const interacting = modal || menu.open || state.busy || state.viewingHistory || state.scrollOffset > 0 || Boolean(draft.draft.text);
	useEffect(() => { if (interacting) setOpenedAt(0); }, [interacting]);
	const standaloneModal = commandOpen && panel.position === "solo";
	useLayoutEffect(() => { if (standaloneModal) onTranscriptFrame?.(undefined); }, [standaloneModal, onTranscriptFrame]);
	const commandPanel = commandOpen && <CommandDialog controller={repl.dialogs} columns={panel.width} rows={panel.height - panelTop} />;
	const viewport = <TranscriptViewport cache={cache} items={items} brandColumns={brandColumns} cwd={cwd} railOffset={railOffset}
		header={<WelcomeHeader columns={transcriptColumns} brandColumns={brandColumns} rows={rows} cwd={cwd} gap={headerGap} />} headerKey={markRows + ":" + headerGap + ":" + cwd}
		native={native} reviewing={state.viewingHistory} requestedAnchor={state.reviewAnchor} modal={modal}
		thinkingId={modal || menu.open || state.viewingHistory || columns < 8 ? undefined : thinkingId} startedAt={state.startedAt}
		expanded={state.viewingHistory && state.expanded} thinkingDisplay={state.thinkingDisplay} historyVersion={state.historyVersion}
		height={viewportRows} columns={transcriptColumns} screenColumns={columns} largeLogo={largeLogo} openedAt={openedAt}
		scrollOffset={state.scrollOffset} onMetrics={modal ? ignoreModalMetrics : repl.setViewportMetrics} onFrame={onTranscriptFrame} />;
	return <Box flexDirection="column" width={columns} height={commandOpen ? screenRows : undefined} overflow="hidden">
		<Box width={columns} flexShrink={0} alignItems="stretch">
			{!standaloneModal && (dockWidth ? <Box width={transcriptColumns} flexDirection="column">
				{viewport}
				{items.length > 0 && <ThemedBox color="brand" marginLeft={railInset(brandColumns)} flexGrow={1} borderStyle="single" borderTop={false} borderRight={false} borderBottom={false} />}
			</Box> : viewport)}
			{commandOpen && !stacked ? <Box flexDirection="column" width={panel.width} marginLeft={dockWidth ? 3 : 0} marginTop={panelTop}>{commandPanel}</Box>
				: sideWidth ? <Box width={sideWidth} flexDirection="column" alignSelf="flex-start" marginTop={panelTop} marginLeft={3}><PromptSuggestions controller={suggestions} availableColumns={sideWidth} availableRows={menuRows} /></Box> : null}
		</Box>
		{stacked && <MessageFrame columns={columns} first={false} gap={false}><Box height={panel.height} flexDirection="column" overflow="hidden">{commandPanel}</Box></MessageFrame>}
		{approval && <Box marginLeft={approvalAxis} width={approval.columns} flexShrink={0} flexDirection="column">
			<PermissionDialog state={permission} policy={repl.permissions} layout={approval} />
		</Box>}
		{!modal && <>
			{warning > 0 && <MessageFrame columns={columns} first={false} gap={false}><TokenWarning display={state.display} columns={frameContentColumns(columns)} /></MessageFrame>}
			{menuLayout && !sideWidth && <MessageFrame columns={columns} first={false} gap={false}>
				<PromptSuggestions controller={suggestions} availableColumns={menuColumns} availableRows={menuRows} />
			</MessageFrame>}
			<PromptInputBox controller={prompt} axis={railInset(brandColumns)} columns={columns} maxRows={maxEditorRows} focus={!state.busy || state.acceptsSteering} rules={rules} mode={showStatus ? permission.mode : undefined} model={model} />
		</>}
	</Box>;
}
