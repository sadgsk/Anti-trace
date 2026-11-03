import { useMemo, useState } from "react";
import { Box } from "ink";
import type { InputTarget } from "../../cli/input/input-dispatcher.ts";
import { useInputTarget } from "../focus/focus-stack.tsx";
import { ListItem } from "./ListItem.tsx";
import type { SelectOption } from "./Select.tsx";
export function MultiSelect<T>({ options, onChange, onCancel, defaultValues = [], active = true, columns = 80 }: {
	options: readonly SelectOption<T>[]; onChange: (values: T[]) => void; onCancel?: () => void; defaultValues?: readonly T[]; active?: boolean; columns?: number;
}) {
	const [selected, setSelected] = useState(0), [values, setValues] = useState(new Set(defaultValues));
	const target = useMemo<InputTarget>(() => ({ id: Symbol("multi-select"), context: "Select", actions: {
		"select:previous": () => setSelected(index => (index - 1 + Math.max(1, options.length)) % Math.max(1, options.length)),
		"select:next": () => setSelected(index => (index + 1) % Math.max(1, options.length)),
		"select:accept": () => onChange([...values]), "select:cancel": () => onCancel?.(),
		"select:toggle": () => { const option = options[selected]; if (!option || option.disabled) return;
			setValues(previous => { const next = new Set(previous); if (next.has(option.value)) next.delete(option.value); else next.add(option.value); return next; }); },
	} }), [options, selected, values, onChange, onCancel]);
	useInputTarget("modal", target, active);
	const start = Math.max(0, selected - 5);
	return <Box flexDirection="column">{options.slice(start, start + 6).map((option, index) => <ListItem key={start + index} selected={selected === start + index} disabled={option.disabled} width={columns}>
		[{values.has(option.value) ? "x" : " "}] {option.label}</ListItem>)}</Box>;
}
