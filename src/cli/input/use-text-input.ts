import { useSyncExternalStore } from "react";
import type { TextInputController, TextInputSnapshot } from "./text-input-controller.ts";

/** Read the latest synchronous draft, including events received before React commits. */
export function useTextInput(controller: TextInputController): TextInputSnapshot {
	return useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
}
