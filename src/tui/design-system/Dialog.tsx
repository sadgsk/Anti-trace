import type { ReactNode } from "react";
import { Box } from "ink";
import { Pane } from "./Pane.tsx";
import { ThemedText } from "../theme/ThemeProvider.tsx";
export function Dialog({ title, subtitle, children, inputGuide, width }: { title: string; subtitle?: string; children: ReactNode; inputGuide?: ReactNode; width?: number }) {
	return <Pane width={width}><ThemedText color="accent" bold>{title}</ThemedText>
		{subtitle ? <ThemedText color="muted" wrap="truncate-end">{subtitle}</ThemedText> : null}
		<Box flexDirection="column" marginY={1}>{children}</Box>{inputGuide}</Pane>;
}
