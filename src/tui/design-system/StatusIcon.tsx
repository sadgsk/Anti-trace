import { ThemedText } from "../theme/ThemeProvider.tsx";
import { figures } from "../theme/figures.ts";
const tones = { success: "success", error: "error", warning: "warning", info: "muted", pending: "dim", loading: "muted" } as const;
export function StatusIcon({ status, withSpace = true }: { status: keyof typeof tones; withSpace?: boolean }) {
	return <ThemedText color={tones[status]}>{figures[status]}{withSpace ? " " : ""}</ThemedText>;
}
