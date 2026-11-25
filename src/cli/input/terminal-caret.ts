import { createContext } from "react";
import type { DOMElement } from "ink";

export interface CaretCell { row: number; column: number }
export type ReadCaret = () => CaretCell | undefined;
export const TerminalCaretContext = createContext<((read?: ReadCaret) => void) | undefined>(undefined);

/** Ink positions each box relative to its parent. Read the committed layout at paint time. */
export function editorCell(node: DOMElement | null, row: number, column: number): CaretCell | undefined {
	if (!node?.yogaNode) return undefined;
	for (let box: DOMElement | undefined = node; box; box = box.parentNode) {
		const layout = box.yogaNode;
		if (!layout) return undefined;
		row += layout.getComputedTop();
		column += layout.getComputedLeft();
	}
	return { row, column };
}
