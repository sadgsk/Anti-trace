import { Text } from "ink";
import type { StructuredDiffHunk } from "../../harness/tools/diff.ts";
import type { ToolUseItem } from "../transcript.ts";
import { ToolUseCard } from "./ToolUseCard.tsx";
import { MessageResponse } from "../messages/MessageResponse.tsx";
import { StructuredDiff } from "../diff/StructuredDiff.tsx";
import { toolDetails, toolText } from "./tool-result.ts";
import { CtrlOToExpand } from "../messages/CtrlOToExpand.tsx";
export function EditToolView({ item, expanded, columns, live = false }: { item: ToolUseItem; expanded: boolean; columns: number; live?: boolean }) {
	const details = toolDetails(item), hunks = details.hunks as StructuredDiffHunk[] | undefined;
	return <ToolUseCard item={item} label="Edit" target={String(item.args.path ?? "")} columns={columns}>
		{item.result ? <MessageResponse columns={Math.max(1, columns - 4)}><Text>{item.status === "error" ? toolText(item) : `Updated · +${details.addedLines ?? "?"} / −${details.removedLines ?? "?"}`} <CtrlOToExpand expanded={expanded} /></Text>
			{hunks?.length ? <StructuredDiff hunks={hunks} columns={Math.max(1, columns - 8)} maxLines={expanded && !live ? undefined : expanded ? 8 : 4} /> : expanded ? <Text>{toolText(item)}</Text> : null}
		</MessageResponse> : null}
	</ToolUseCard>;
}
