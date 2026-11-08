import assert from "node:assert/strict";
import { Type } from "typebox";
import type { Harness } from "../../src/harness/harness.ts";
import type { AgentMessage, AgentTool } from "../../src/types.ts";

export const HISTORY_TEXT = "old history: " + "x".repeat(100000);

/** Seed through the real prompt path, including its persisted messages. */
export async function seedCompactionHistory(harness: Harness): Promise<void> {
	await harness.prompt(HISTORY_TEXT);
}

export function historyTool(calls: string[]): AgentTool {
	return {
		name: "history", label: "History", description: "Return controlled tool output", parameters: Type.Object({ id: Type.String() }),
		async execute(_id, raw) {
			const id = (raw as { id: string }).id;
			calls.push(id);
			return { content: [{ type: "text", text: id === "old" ? "old-tool:" + "a".repeat(100000) : `${id}:` + "b".repeat(4000) }], details: {} };
		},
	};
}

export function assertToolPairs(messages: readonly AgentMessage[]): void {
	const pending = new Set<string>();
	for (const message of messages) {
		if (message.role === "assistant") {
			assert.equal(pending.size, 0, "all previous tool calls must have results");
			for (const block of message.content) if (block.type === "toolCall") {
				assert.equal(pending.has(block.id), false);
				pending.add(block.id);
			}
		} else if (message.role === "toolResult") {
			assert.equal(pending.delete(message.toolCallId), true, `orphaned tool result ${message.toolCallId}`);
		} else assert.equal(pending.size, 0);
	}
	assert.equal(pending.size, 0);
}
