import { useMemo, useRef, useSyncExternalStore } from "react";
import { Box } from "ink";
import type { ReplController } from "../../cli/repl/repl-controller.ts";
import type { PromptInputController } from "../../cli/input/prompt-input-controller.ts";
import { layoutTextInput } from "../../cli/input/text-input-layout.ts";
import type { PromptSuggestionsController } from "../suggestions/prompt-suggestions-controller.ts";
import { PromptSuggestions } from "../suggestions/PromptSuggestions.tsx";
import { layoutCommandMenu } from "../suggestions/command-menu-layout.ts";
import { WelcomeHeader } from "./WelcomeHeader.tsx";
import { StatusLine, TokenWarning } from "./StatusLine.tsx";
import { SpinnerWithVerb } from "./Spinner.tsx";
import { PromptInputBox } from "./PromptInputBox.tsx";
import { PermissionDialog } from "../permissions/PermissionDialog.tsx";
import { CommandDialog } from "../commands/CommandDialog.tsx";
import { groupTranscript, TranscriptItemView } from "../messages/TranscriptView.tsx";
import { TranscriptViewport, type TranscriptElements } from "./TranscriptViewport.tsx";
export interface ReplScreenProps { repl: ReplController; prompt: PromptInputController; suggestions: PromptSuggestionsController; cwd: string; columns: number; rows: number; nativeScrollback?: boolean }
export function ReplScreen({ repl, prompt, suggestions, cwd, columns, rows, nativeScrollback = false }: ReplScreenProps) {
	const state = useSyncExternalStore(repl.subscribe, repl.getSnapshot, repl.getSnapshot);
	const draft = useSyncExternalStore(prompt.subscribe, prompt.getSnapshot, prompt.getSnapshot);
	const menu = useSyncExternalStore(suggestions.subscribe, suggestions.getSnapshot, suggestions.getSnapshot);
	const permission = useSyncExternalStore(repl.permissions.subscribe, repl.permissions.getSnapshot, repl.permissions.getSnapshot);
	const dialog = useSyncExternalStore(repl.dialogs.subscribe, repl.dialogs.getSnapshot, repl.dialogs.getSnapshot);
	const items = useMemo(() => groupTranscript([...state.transcript, ...state.activeItems]), [state.transcript, state.activeItems]);
	const elements = useRef<TranscriptElements>(new Map());
	const screenRows = Math.max(1, rows - 1), maxEditorRows = Math.max(1, Math.min(6, Math.floor(rows / 4)));
	const editorRows = Math.min(maxEditorRows, layoutTextInput(draft.draft.text, draft.availableColumns).lines.length);
	const warning = state.display.contextWindow && state.display.contextUsed / state.display.contextWindow >= 0.75 ? 1 : 0;
	const inputRows = editorRows + 2 + Number(draft.draft.references.length > 0) + Number(draft.isPasting);
	const menuRows = menu.open ? Math.max(1, Math.min(12, screenRows - inputRows - warning - 2)) : 0;
	const menuLayout = menu.open ? layoutCommandMenu(menu, columns, menuRows) : null;
	const usedMenuRows = menuLayout ? (menuLayout.framed ? 5 : 1) + Math.max(1, menuLayout.count) + Number(Boolean(menuLayout.more)) : 0;
	const viewportRows = Math.max(0, screenRows - 1 - inputRows - warning - usedMenuRows - Number(state.busy));
	const native = nativeScrollback && !state.viewingHistory && state.scrollOffset === 0 && !permission.request && !dialog && !menu.open;
	// Expansion is an interactive reading view. Keep the committed native transcript's layout stable.
	const displayExpanded = state.viewingHistory ? state.expanded : false;
	const content = <><WelcomeHeader cwd={cwd} display={state.display} columns={columns} rows={rows} permissionMode={permission.mode} />
		{items.map(item => <Box key={item.id} ref={element => { if (element) elements.current.set(item.id, { element, tool: item.kind === "tool" || item.kind === "reads" }); else elements.current.delete(item.id); }} flexDirection="column" flexShrink={0}><TranscriptItemView item={item} expanded={displayExpanded} thinkingDisplay={state.thinkingDisplay} columns={columns} /></Box>)}</>;
	return <Box flexDirection="column" width={columns} minHeight={screenRows} height={native ? undefined : screenRows} overflow={native ? undefined : "hidden"}>
		{permission.request ? <PermissionDialog state={permission} policy={repl.permissions} columns={columns} availableRows={Math.max(1, screenRows - 1)} />
			: dialog ? <><Box flexGrow={1} /><CommandDialog controller={repl.dialogs} columns={columns} rows={screenRows - 1} /></>
				: <>
					<TranscriptViewport natural={native} reviewing={state.viewingHistory} requestedAnchor={state.reviewAnchor} elements={elements.current} height={viewportRows} columns={columns} scrollOffset={state.scrollOffset} onMetrics={repl.setViewportMetrics}>{content}</TranscriptViewport>
					{native ? <Box flexGrow={1} /> : null}
					{state.busy ? <SpinnerWithVerb phase={state.phase} startedAt={state.startedAt} lastEventAt={state.lastEventAt} outputChars={state.outputChars} columns={columns} /> : null}
					<TokenWarning display={state.display} columns={columns} />
					<PromptSuggestions controller={suggestions} availableColumns={columns} availableRows={menuRows} />
					<PromptInputBox controller={prompt} columns={columns} maxRows={maxEditorRows} focus={!state.busy} mode={permission.mode} resume={false} />
				</>}
		<Box flexShrink={0}><StatusLine display={state.display} mode={permission.mode} expanded={state.expanded} columns={columns} /></Box>
	</Box>;
}
