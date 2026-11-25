import type { ReactNode } from "react";
import { Box } from "ink";
export function MessageResponse({ children, columns }: { children: ReactNode; columns: number }) {
	return <Box flexDirection="column" width={columns}>{children}</Box>;
}
