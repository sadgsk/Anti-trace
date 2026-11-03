import { Text } from "ink";
import { ThemedText } from "../theme/ThemeProvider.tsx";
import { displayText } from "../utils/text.ts";
/** Visible links remain copyable in terminals without OSC-8 support. */
export function FilePathLink({ href, children }: { href: string; children?: string }) {
	const target = displayText(href), label = displayText(children ?? href);
	return <Text><ThemedText color="accent" underline>{label}</ThemedText>{label !== target ? <ThemedText color="muted"> ({target})</ThemedText> : null}</Text>;
}
