import { useEffect, useMemo, useState } from "react";
import { Box } from "ink";
import type { InputTarget } from "../../cli/input/input-dispatcher.ts";
import { useInputTarget } from "../focus/focus-stack.tsx";
import { ListItem } from "./ListItem.tsx";
import { ThemedText } from "../theme/ThemeProvider.tsx";
import { TextInputController } from "../../cli/input/text-input-controller.ts";
import { createTextInputState } from "../../cli/input/text-input-state.ts";
import { BaseTextInput } from "../../cli/input/base-text-input.tsx";
import { useLocale } from "../locale/LocaleProvider.tsx";
export interface SelectOption<T> { label: string; value: T; description?: string; disabled?: boolean;
	type?: "input"; placeholder?: string; initialValue?: string; onChange?: (value: string) => void }
export function Select<T>({ options, onChange, onCancel, selectedIndex, onNavigate, active = true, visibleOptionCount = 6, columns = 80, hideIndexes = false }: {
	options: readonly SelectOption<T>[]; onChange: (value: T) => void; onCancel?: () => void;
	selectedIndex?: number; onNavigate?: (index: number) => void; active?: boolean; visibleOptionCount?: number; columns?: number; hideIndexes?: boolean;
}) {
	const [internal, setInternal] = useState(0), selected = Math.max(0, Math.min(options.length - 1, selectedIndex ?? internal));
	const { t } = useLocale();
	const [editing, setEditing] = useState(false), option = options[selected];
	const editor = useMemo(() => new TextInputController({ availableColumns: Math.max(1, columns - 4), multiline: false,
		initialState: createTextInputState(option?.initialValue ?? ""), onChange: state => option?.onChange?.(state.text) }), [option]);
	useEffect(() => () => editor.dispose(), [editor]);
	useEffect(() => editor.setAvailableColumns(Math.max(1, columns - 4)), [editor, columns]);
	const target = useMemo<InputTarget>(() => {
		const move = (step: number) => {
			for (let offset = 1; offset <= options.length; offset++) {
				const index = (selected + step * offset + options.length * offset) % options.length;
				if (!options[index]?.disabled) { setInternal(index); onNavigate?.(index); break; }
			}
		};
		return { id: Symbol("select"), context: "Select", actions: {
			...editor.target.actions,
			"select:previous": () => { if (editing) editor.handleAction("input:up"); else move(-1); },
			"select:next": () => { if (editing) editor.handleAction("input:down"); else move(1); },
			"select:cancel": () => { if (editing) setEditing(false); else onCancel?.(); },
			"select:accept": () => { const option = options[selected]; if (!option || option.disabled) return;
				if (option.type === "input" && !editing) setEditing(true); else onChange(option.value); },
		}, onInput: event => {
			if (editing) { editor.handleInput(event); return; }
			if (!hideIndexes && event.type === "text" && /^[1-9]$/.test(event.text)) {
				const option = options[Number(event.text) - 1]; if (option && !option.disabled) onChange(option.value);
			}
		} };
	}, [options, selected, onChange, onNavigate, onCancel, hideIndexes, editor, editing]);
	useInputTarget("modal", target, active);
	const count = Math.max(1, visibleOptionCount), start = Math.max(0, Math.min(selected - Math.floor(count / 2), options.length - count));
	return <Box flexDirection="column">{options.slice(start, start + count).map((option, offset) => <ListItem key={start + offset} selected={selected === start + offset} disabled={option.disabled} width={columns}>
		{hideIndexes ? "" : `${start + offset + 1}. `}{option.label}{option.description ? ` · ${option.description}` : ""}</ListItem>)}
		{!options.length ? <ThemedText color="dim">{t("无匹配项")}</ThemedText> : options.length > count ? <ThemedText color="dim">{selected + 1}/{options.length}</ThemedText> : null}
		{editing && option?.type === "input" ? <BaseTextInput controller={editor} placeholder={option.placeholder} maxRows={1} /> : null}
	</Box>;
}
