import { ThemedText } from "../theme/ThemeProvider.tsx";
import type { ToolUseItem } from "../transcript.ts";
import { ToolUseCard } from "./ToolUseCard.tsx";
import { frameContentColumns } from "../messages/MessageFrame.tsx";
import { MessageResponse } from "../messages/MessageResponse.tsx";
import { toolDetails, toolText } from "./tool-result.ts";
import { displayText } from "../utils/text.ts";

export function SkillToolView({ item, expanded, columns }: { item: ToolUseItem; expanded: boolean; columns: number }) {
	const details = toolDetails(item);
	return <ToolUseCard item={item} label="Skill" target={String(item.args.skill ?? "")} columns={columns}>
		{item.result ? <MessageResponse columns={frameContentColumns(columns)}>
			<ThemedText>{toolText(item)}</ThemedText>
			{expanded && item.status !== "error" ? <>
				<ThemedText wrap="wrap">{displayText(String(details.path ?? ""))}</ThemedText>
				{item.args.args ? <ThemedText wrap="wrap">{displayText(String(item.args.args))}</ThemedText> : null}
			</> : null}
		</MessageResponse> : null}
	</ToolUseCard>;
}
