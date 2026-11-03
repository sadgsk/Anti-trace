import { useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { Box } from "ink";
import type { InputTarget } from "../../cli/input/input-dispatcher.ts";
import { TextInputController } from "../../cli/input/text-input-controller.ts";
import { BaseTextInput } from "../../cli/input/base-text-input.tsx";
import { useInputTarget } from "../focus/focus-stack.tsx";
import { Dialog } from "./Dialog.tsx";
import { ListItem } from "./ListItem.tsx";
export function FuzzyPicker<T>({ title, items, getKey, getLabel, filterItem, renderPreview, onSelect, onCancel, columns = 80 }: {
	title: string; items: readonly T[]; getKey: (item: T) => string; getLabel: (item: T) => string;
	filterItem?: (item: T, query: string) => boolean; renderPreview?: (item: T) => ReactNode;
	onSelect: (item: T) => void; onCancel: () => void; columns?: number;
}) {
	const editor = useMemo(() => new TextInputController({ availableColumns: Math.max(1, columns - 6), multiline: false }), []);
	useEffect(() => () => editor.dispose(), [editor]);
	useEffect(() => editor.setAvailableColumns(Math.max(1, columns - 6)), [editor, columns]);
	const input = useSyncExternalStore(editor.subscribe, editor.getSnapshot, editor.getSnapshot), [index, setIndex] = useState(0);
	const matches = items.filter(item => filterItem ? filterItem(item, input.state.text) : getLabel(item).toLowerCase().includes(input.state.text.toLowerCase()));
	const selected = Math.min(index, Math.max(0, matches.length - 1));
	const target = useMemo<InputTarget>(() => ({ ...editor.target, id: Symbol("picker"), context: "Picker", actions: { ...editor.target.actions,
		"picker:previous": () => setIndex(value => Math.max(0, value - 1)), "picker:next": () => setIndex(value => Math.min(matches.length - 1, value + 1)),
		"picker:accept": () => { const item = matches[selected]; if (item !== undefined) onSelect(item); }, "picker:cancel": onCancel,
	}, onInput: event => { setIndex(0); editor.handleInput(event); } }), [editor, matches, selected, onSelect, onCancel]);
	useInputTarget("modal", target);
	const start = Math.max(0, selected - 5);
	return <Dialog title={title} subtitle={`${matches.length}/${items.length}`} width={columns}>
		<BaseTextInput controller={editor} />{matches.slice(start, start + 6).map((item, offset) => <ListItem key={getKey(item)} selected={start + offset === selected} width={columns - 4}>{getLabel(item)}</ListItem>)}
		{matches[selected] !== undefined && renderPreview ? <Box flexDirection="column">{renderPreview(matches[selected]!)}</Box> : null}
	</Dialog>;
}
