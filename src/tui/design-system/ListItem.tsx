import type { ReactNode } from "react";
import { Box } from "ink";
import stringWidth from "string-width";
import { ThemedText } from "../theme/ThemeProvider.tsx";
import { truncateText } from "../utils/text.ts";

export function ListItem({ selected, disabled, children, width }: { selected?: boolean; disabled?: boolean; children: ReactNode; width?: number }) {
	if (width === 1) return <ThemedText>{selected ? "◢" : " "}</ThemedText>;
	const field = width === undefined ? undefined : Math.max(0, width - 2);
	const text = field !== undefined && typeof children === "string" ? truncateText(children, field) : children;
	const fill = field !== undefined && typeof text === "string" ? " ".repeat(Math.max(0, field - stringWidth(text))) : "";
	return <Box width={width} height={1} flexShrink={0}>
		<ThemedText wrap="truncate-end">{selected ? "◢" : " "}<ThemedText inverse={selected} bold={selected} strikethrough={disabled}>{text}{fill}</ThemedText>{selected ? "◤" : " "}</ThemedText>
	</Box>;
}
