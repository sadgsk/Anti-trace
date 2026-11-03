import { useEffect, useState } from "react";
import { Text } from "ink";
import { ThemedText } from "../theme/ThemeProvider.tsx";
import type { ReplSnapshot } from "../../cli/repl/repl-controller.ts";
import { truncateText } from "../utils/text.ts";
import { useLocale } from "../locale/LocaleProvider.tsx";
export function ShimmerText({ text, frame }: { text: string; frame: number }) {
	return <Text>{[...text].map((character, index) => <ThemedText key={index} color={index === frame % Math.max(1, text.length) ? "brand" : "muted"}>{character}</ThemedText>)}</Text>;
}
export function SpinnerAnimationRow({ phase, startedAt, lastEventAt, outputChars, columns }: Pick<ReplSnapshot, "phase" | "startedAt" | "lastEventAt" | "outputChars"> & { columns: number }) {
	const [frame, setFrame] = useState(0);
	const { t } = useLocale();
	useEffect(() => { const timer = setInterval(() => setFrame(value => value + 1), 100); return () => clearInterval(timer); }, []);
	const label = { thinking: "思考中", streaming: "生成回复中", tool: "工具执行中", compacting: "压缩上下文中" }[phase];
	const stalled = Date.now() - lastEventAt > 5000;
	const suffix = ` · ${Math.max(0, Math.floor((Date.now() - startedAt) / 1000))}s${outputChars ? ` · ${outputChars} chars` : ""} · Ctrl+C 中断`;
	return <Text wrap="truncate-end"><ThemedText color={stalled ? "warning" : "accent"}>{"⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"[frame % 10]} </ThemedText><ShimmerText text={t(label)} frame={frame} />
		<ThemedText color="dim">{truncateText(t(suffix), Math.max(1, columns - 16))}</ThemedText></Text>;
}
export const SpinnerWithVerb = SpinnerAnimationRow;
