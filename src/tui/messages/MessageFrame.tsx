import type { ReactNode } from "react";
import { ThemedBox } from "../theme/ThemeProvider.tsx";

export const frameContentColumns = (columns: number) => Math.max(1, columns - 4);
/** Shared geometry; each content component owns its semantic title and status. */
export function MessageFrame({ kind, columns, children }: { kind: "tool" | "reply"; columns: number; children: ReactNode }) {
	return <ThemedBox flexDirection="column" flexShrink={0} width={Math.max(1, columns)} marginTop={1} borderStyle="round" color={kind === "tool" ? "accent" : "dim"} paddingX={1}>{children}</ThemedBox>;
}
