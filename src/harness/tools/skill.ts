import { Type } from "typebox";
import type { AgentTool } from "../../types.ts";
import type { SkillRuntime } from "../skills/runtime.ts";

const skillSchema = Type.Object({ skill: Type.String({ description: "Name from the available skills catalog" }),
	args: Type.Optional(Type.String({ description: "Arguments for the selected skill" })) });

export function createSkillTool(runtime: SkillRuntime, sessionId: () => string, availableTools: () => string[]): AgentTool<typeof skillSchema> {
	return { name: "skill", label: "skill", parameters: skillSchema,
		description: "Load the full instructions of one named skill into this conversation. Consult the available skills catalog and invoke a matching skill before performing its task. Then follow its instructions using the existing tools. This tool does not list or execute all skills.",
		async execute(_id, { skill, args = "" }, signal) {
			signal?.throwIfAborted();
			const message = runtime.prepare(skill, args, "model", sessionId(), availableTools());
			signal?.throwIfAborted();
			return { content: [{ type: "text", text: `Loaded skill: ${skill}` }],
				details: { skill, args, path: message.metadata?.path, allowedTools: message.metadata?.allowedTools }, newMessages: [message] };
		},
	};
}
