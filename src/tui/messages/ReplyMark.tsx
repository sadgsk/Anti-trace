import { createContext, useContext, useEffect, useState } from "react";
import { Text } from "ink";
import { replyFrameAt, replyFrameMs, replyGlyphBase } from "./reply-animation.ts";

export const ReplyGraphicsContext = createContext(false);
// Match only the reserved branch, ahead of any user/provider content.
const thinkingBranch = /^((?:\x1b\[[\d;]*m| )*[∇│](?:\x1b\[[\d;]*m)*)(?:──|─ |  )/u;
const textPoses = ["▽", "◿", "⋈", "◺", "▽", "◹", "⋈", "◸"];
export function ThinkingIndicator({ line, startedAt, columns }: { line: string; startedAt: number; columns: number }) {
	const graphic = useContext(ReplyGraphicsContext) && columns >= 20;
	const [now, setNow] = useState(Date.now);
	useEffect(() => {
		const timer = setInterval(() => setNow(Date.now()), graphic ? replyFrameMs : 200);
		return () => clearInterval(timer);
	}, [graphic]);
	const frame = replyFrameAt(now - startedAt);
	const mark = graphic ? String.fromCharCode(replyGlyphBase + frame) : textPoses[Math.floor(frame * textPoses.length / 60)]!;
	return <Text wrap="truncate-end">{line.replace(thinkingBranch, (_, prefix: string) => prefix + "─" + mark)}</Text>;
}
