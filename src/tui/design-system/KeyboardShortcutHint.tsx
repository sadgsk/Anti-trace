import { Text } from "ink";
import { ThemedText } from "../theme/ThemeProvider.tsx";
export function KeyboardShortcutHint({ shortcut, action, parens = false, bold = true }: { shortcut: string; action: string; parens?: boolean; bold?: boolean }) {
	return <ThemedText color="dim">{parens ? "(" : ""}<ThemedText color="accent" bold={bold}>{shortcut}</ThemedText><Text> {action}</Text>{parens ? ")" : ""}</ThemedText>;
}
