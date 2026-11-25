import type { ReactNode } from "react";
import { Box } from "ink";
import { ThemedBox, ThemedText } from "../theme/ThemeProvider.tsx";
import { logoWidth } from "../layout/brand-art.ts";

export const railInset = (columns: number) => columns >= 12 ? Math.round(logoWidth(columns) * 0.075) : 0;
export const railBranch = (columns: number) => columns >= 20 ? 5 : columns >= 6 ? 3 : 0;
export const frameContentColumns = (columns: number) => Math.max(1, columns - railInset(columns) - railBranch(columns));

/** A message owns one junction. Wrapped lines and the space between messages continue the same rail. */
export function MessageFrame({ columns, marker = "◇", first = true, gap = true, children }: { columns: number; marker?: "◇" | "∇"; first?: boolean; gap?: boolean; children: ReactNode }) {
	const branch = railBranch(columns);
	return <Box flexDirection="row" marginLeft={railInset(columns)} flexShrink={0}>
		{branch > 0 && <Box width={branch} flexShrink={0} flexDirection="column">
			<ThemedText>{first ? marker + (branch === 5 ? "──" : "─") : "│"}</ThemedText>
			<ThemedBox color="brand" flexGrow={1} borderStyle="single" borderLeft borderRight={false} borderTop={false} borderBottom={false} />
		</Box>}
		<Box width={frameContentColumns(columns)} flexShrink={0} flexDirection="column" paddingBottom={gap ? 1 : 0}>{children}</Box>
	</Box>;
}
