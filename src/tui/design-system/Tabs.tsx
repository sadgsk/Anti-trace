import { Children, useMemo, useState, type ReactElement, type ReactNode } from "react";
import { Box, Text } from "ink";
import { ThemedText } from "../theme/ThemeProvider.tsx";
import type { InputTarget } from "../../cli/input/input-dispatcher.ts";
import { useInputTarget } from "../focus/focus-stack.tsx";
export interface TabProps { id: string; title: string; children: ReactNode }
export function Tab({ children }: TabProps) { return <>{children}</>; }
export function Tabs({ children, selectedTab, onTabChange, active = true }: { children: ReactElement<TabProps>[]; selectedTab?: string; onTabChange?: (id: string) => void; active?: boolean }) {
	const tabs = Children.toArray(children) as ReactElement<TabProps>[], [internal, setInternal] = useState(tabs[0]?.props.id);
	const index = Math.max(0, tabs.findIndex(tab => tab.props.id === (selectedTab ?? internal)));
	const target = useMemo<InputTarget>(() => {
		const move = (step: number) => { const tab = tabs[(index + step + tabs.length) % tabs.length]; if (tab) { setInternal(tab.props.id); onTabChange?.(tab.props.id); } };
		return { id: Symbol("tabs"), context: "Tabs", actions: { "tabs:previous": () => move(-1), "tabs:next": () => move(1) } };
	}, [tabs, index, onTabChange]);
	useInputTarget("modal", target, active);
	return <Box flexDirection="column"><Text>{tabs.map((tab, i) => <ThemedText key={tab.props.id} color={i === index ? "accent" : "dim"} underline={i === index}> {tab.props.title} </ThemedText>)}</Text>{tabs[index]}</Box>;
}
