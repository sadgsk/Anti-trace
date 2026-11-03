import { createContext, useContext, useLayoutEffect, type ReactNode } from "react";
import type { InputDispatcher, InputTarget } from "../../cli/input/input-dispatcher.ts";
import type { Keybinding } from "../../cli/input/keybindings.ts";
export type FocusLayer = "modal" | "suggestion" | "editor" | "global";
const priority: Record<FocusLayer, number> = { modal: 0, suggestion: 1, editor: 2, global: 3 };
/** One router; modal input is exclusive while global interruption remains reachable. */
export class FocusStack {
	private readonly targets = new Map<symbol, { layer: FocusLayer; target: InputTarget }>();
	constructor(private readonly dispatcher: InputDispatcher, private readonly bindings: readonly Keybinding[]) {}
	set(layer: FocusLayer, target: InputTarget, active = true): void {
		if (active) this.targets.set(target.id, { layer, target }); else this.targets.delete(target.id);
		const ordered = [...this.targets.values()].sort((a, b) => priority[a.layer] - priority[b.layer]);
		const modals = ordered.filter(entry => entry.layer === "modal");
		this.dispatcher.configure(modals.length ? [modals.at(-1)!.target, ...ordered.filter(entry => entry.layer === "global").map(entry => entry.target)]
			: ordered.map(entry => entry.target), this.bindings);
	}
	remove(target: InputTarget): void { this.set("global", target, false); }
}
const FocusContext = createContext<FocusStack | null>(null);
export function FocusStackProvider({ stack, children }: { stack: FocusStack; children: ReactNode }) {
	return <FocusContext.Provider value={stack}>{children}</FocusContext.Provider>;
}
export function useInputTarget(layer: FocusLayer, target: InputTarget, active = true): void {
	const stack = useContext(FocusContext);
	useLayoutEffect(() => {
		if (!stack) return;
		stack.set(layer, target, active);
		return () => stack.remove(target);
	}, [stack, layer, target, active]);
}
