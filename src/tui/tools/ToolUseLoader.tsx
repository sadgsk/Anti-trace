import { useEffect, useState } from "react";
import { ThemedText } from "../theme/ThemeProvider.tsx";
/** Animation lives at the leaf; no transcript/controller timers. */
export function ToolUseLoader() {
	const [frame, setFrame] = useState(0);
	useEffect(() => { const timer = setInterval(() => setFrame(value => (value + 1) % 4), 160); return () => clearInterval(timer); }, []);
	return <ThemedText color={frame < 2 ? "accent" : "dim"}>● </ThemedText>;
}
