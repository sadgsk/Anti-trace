import { useContext, useEffect, useState } from "react";
import { ThemedText } from "../theme/ThemeProvider.tsx";
import { LayoutOnlyContext } from "../layout/layout-only.ts";
/** Animation lives at the leaf; no transcript/controller timers. */
export function ToolUseLoader() {
	const [frame, setFrame] = useState(0);
	const layoutOnly = useContext(LayoutOnlyContext);
	useEffect(() => { if (layoutOnly) return; const timer = setInterval(() => setFrame(value => (value + 1) % 4), 160); return () => clearInterval(timer); }, [layoutOnly]);
	return <ThemedText color={frame < 2 ? "accent" : "dim"}>● </ThemedText>;
}
