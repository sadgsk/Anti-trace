import assert from "node:assert/strict";
import test from "node:test";
import { Type } from "typebox";
import type { AgentTool } from "../../src/types.ts";
import { createTestHarness, messageText } from "../support/harness.ts";

test("aborting the first tool pairs every call and permits a fresh prompt", async (t) => {
	let executed = 0;
	const { harness, agent, scripted } = createTestHarness(t, [
		{ toolCalls: ["a", "b", "c"].map((id) => ({ id, name: "abort", arguments: {} })) },
		{ text: "next prompt works" },
	]);
	const tool: AgentTool = { name: "abort", label: "Abort", description: "Abort", parameters: Type.Object({}),
		execute: async () => { executed++; harness.abort(); throw new Error("Aborted"); } };
	agent.state.tools = [tool];
	await harness.prompt("interrupt this batch");
	assert.equal(executed, 1);
	const results = agent.state.messages.filter((message) => message.role === "toolResult");
	assert.deepEqual(results.map((message) => message.toolCallId), ["a", "b", "c"]);
	assert.ok(results.every((message) => message.isError));
	assert.match(messageText(results[0]), /执行结果未知/);
	assert.doesNotMatch(messageText(results[1]), /执行结果未知/);
	assert.equal(scripted.requests.length, 1, "aborted batches cannot start another model turn");
	assert.equal(agent.state.pendingToolCalls.size, 0);
	assert.equal(agent.state.isStreaming, false);
	await harness.prompt("continue");
	assert.equal(messageText(agent.state.messages.at(-1)), "next prompt works");
});

test("a cancelled tool returning an error preserves its result and marks the uncertain effect", async t => {
	const { harness, agent } = createTestHarness(t, [{ toolCalls: [{ id: "c", name: "cancel", arguments: {} }] }]);
	agent.state.tools = [{ name: "cancel", label: "Cancel", description: "Cancel", parameters: Type.Object({}),
		execute: async () => {
			void harness.abort();
			return { isError: true, content: [{ type: "text", text: "external command disconnected" }], details: { request: "cmd" } };
		} }];
	await harness.prompt("run");
	const result = agent.state.messages.find(message => message.role === "toolResult");
	assert.equal(result?.toolCallId, "c");
	assert.deepEqual(result?.details, { request: "cmd" });
	assert.match(messageText(result), /external command disconnected.*执行结果未知/);
});
