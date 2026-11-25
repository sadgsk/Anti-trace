import { ThemedText } from "../theme/ThemeProvider.tsx";
import { useLocale } from "../locale/LocaleProvider.tsx";
import type { StructuredDiffHunk } from "../../harness/tools/diff.ts";
import type { ToolUseItem } from "../transcript.ts";
import { ToolUseCard } from "./ToolUseCard.tsx";
import { frameContentColumns } from "../messages/MessageFrame.tsx";
import { MessageResponse } from "../messages/MessageResponse.tsx";
import { StructuredDiff } from "../diff/StructuredDiff.tsx";
import { toolDetails, toolText } from "./tool-result.ts";
import { CtrlOToExpand } from "../messages/CtrlOToExpand.tsx";
export function EditToolView({ item, expanded, columns, live = false }: { item: ToolUseItem; expanded: boolean; columns: number; live?: boolean }) {
	const { t } = useLocale();
	const details = toolDetails(item), hunks = details.hunks as StructuredDiffHunk[] | undefined;
	return <ToolUseCard item={item} label="Edit" target={String(item.args.path ?? "")} columns={columns}>
		{item.result ? <MessageResponse columns={frameContentColumns(columns)}><ThemedText>{item.status === "error" ? toolText(item) : `${t("已修改")} · +${details.addedLines ?? "?"} / −${details.removedLines ?? "?"}`} <CtrlOToExpand expanded={expanded} /></ThemedText>
			{hunks?.length ? <StructuredDiff hunks={hunks} columns={frameContentColumns(columns)} maxLines={expanded && !live ? undefined : expanded ? 8 : 4} /> : expanded ? <ThemedText>{toolText(item)}</ThemedText> : null}
		</MessageResponse> : null}
	</ToolUseCard>;
}
