import { Text } from "ink";
import type { ToolUseItem } from "../transcript.ts";
import { ToolUseCard } from "./ToolUseCard.tsx";
import { MessageResponse } from "../messages/MessageResponse.tsx";
import { toolDetails, toolText } from "./tool-result.ts";
import { displayText } from "../utils/text.ts";

export function SkillToolView({ item, expanded, columns }: { item: ToolUseItem; expanded: boolean; columns: number }) {
	const details = toolDetails(item);
	return <ToolUseCard item={item} label="Skill" target={String(item.args.skill ?? "")} columns={columns}>
		{item.result ? <MessageResponse columns={Math.max(1, columns - 4)}>
			<Text>{toolText(item)}</Text>
			{expanded && item.status !== "error" ? <>
				<Text wrap="wrap">{displayText(String(details.path ?? ""))}</Text>
				{item.args.args ? <Text wrap="wrap">{displayText(String(item.args.args))}</Text> : null}
			</> : null}
		</MessageResponse> : null}
	</ToolUseCard>;
}
