import { Text } from "ink";
import { extname } from "node:path";
import type { StructuredDiffHunk } from "../../harness/tools/diff.ts";
import type { ToolUseItem } from "../transcript.ts";
import { ToolUseCard } from "./ToolUseCard.tsx";
import { MessageResponse } from "../messages/MessageResponse.tsx";
import { StructuredDiff } from "../diff/StructuredDiff.tsx";
import { HighlightedCode } from "../markdown/HighlightedCode.tsx";
import { toolDetails, toolText } from "./tool-result.ts";
import { CtrlOToExpand } from "../messages/CtrlOToExpand.tsx";
export function WriteToolView({ item, expanded, columns, live = false }: { item: ToolUseItem; expanded: boolean; columns: number; live?: boolean }) {
	const details = toolDetails(item), hunks = details.hunks as StructuredDiffHunk[] | undefined;
	const code = String(item.args.content ?? (details.previewLines as string[] | undefined)?.join("\n") ?? "");
	return <ToolUseCard item={item} label={details.created ? "Create" : "Write"} target={String(item.args.path ?? "")} columns={columns}>
		{item.result ? <MessageResponse columns={Math.max(1, columns - 4)}><Text>{item.status === "error" ? toolText(item) : `Wrote ${details.lineCount ?? code.split("\n").length} lines`} <CtrlOToExpand expanded={expanded} /></Text>
			{item.status !== "error" ? hunks?.length ? <StructuredDiff hunks={hunks} columns={Math.max(1, columns - 8)} maxLines={expanded && !live ? undefined : 4} />
				: expanded ? <HighlightedCode code={code} columns={Math.max(1, columns - 8)} language={extname(String(item.args.path)).slice(1)} maxLines={live ? 8 : undefined} /> : null : null}
		</MessageResponse> : null}
	</ToolUseCard>;
}
