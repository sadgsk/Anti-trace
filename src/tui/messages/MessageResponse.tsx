import type { ReactNode } from "react";
import { Box } from "ink";
import { ThemedText } from "../theme/ThemeProvider.tsx";
export function MessageResponse({ children, columns }: { children: ReactNode; columns: number }) {
	return <Box><ThemedText color="dim">  ⎿ </ThemedText><Box flexDirection="column" width={Math.max(1, columns - 4)}>{children}</Box></Box>;
}
