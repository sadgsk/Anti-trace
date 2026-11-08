import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { Type } from "typebox";
import type { AgentTool } from "../../src/types.ts";
import { deferred } from "../support/fixtures.ts";
import { createTestHarness, messageText } from "../support/harness.ts";

test("text and image prompts finish idle and preserve independent request history", async (t) => {
	const { harness, agent, events, scripted } = createTestHarness(t, [{ text: "one" }, { text: "two" }]);
	const image = { type: "image" as const, mimeType: "image/png", data: "ZmFrZQ==" };
	await harness.prompt("first", [image]);
	assert.equal(agent.state.isStreaming, false);
	assert.equal(agent.state.streamingMessage, undefined);
	assert.equal(agent.state.pendingToolCalls.size, 0);
	assert.ok(scripted.requests[0]!.context.messages[0]!.content.some((block) => block.type === "image" && block.data === image.data));
	await harness.prompt("second");
	assert.deepEqual(agent.state.messages.map((message) => message.role), ["user", "assistant", "user", "assistant"]);
	assert.equal(messageText(agent.state.messages.at(-1)), "two");
	assert.equal(scripted.requests[0]!.context.messages.length, 1, "later turns cannot mutate captured requests");
	assert.equal(events.filter((event) => event.type === "agent_start").length, 2);
	assert.equal(events.filter((event) => event.type === "agent_end").length, 2);
	assert.equal(scripted.pendingResponses, 0);
});

test("a real write/read tool batch changes only the fixture and reaches the follow-up model", async (t) => {
	const { harness, agent, root, scripted } = createTestHarness(t, [
		{ toolCalls: [
			{ id: "write-1", name: "write", arguments: { path: "folder with spaces/a.txt", content: "hello 世界\n" } },
			{ id: "read-1", name: "read", arguments: { path: "folder with spaces/a.txt" } },
		] },
		(request) => {
			const results = request.context.messages.filter((message) => message.role === "toolResult");
			assert.deepEqual(results.map((message) => message.toolCallId), ["write-1", "read-1"]);
			assert.ok(results.every((message) => !message.isError));
			assert.match(messageText(results[1]), /hello 世界/);
			return { text: "done" };
		},
	]);
	await harness.prompt("write and read");
	assert.equal(readFileSync(join(root, "folder with spaces", "a.txt"), "utf8"), "hello 世界\n");
	assert.deepEqual(agent.state.messages.map((message) => message.role), ["user", "assistant", "toolResult", "toolResult", "assistant"]);
	assert.equal(scripted.requests.length, 2);
});

for (const scenario of [
	{ name: "unknown tool", tool: "missing", args: {}, error: /not found/ },
	{ name: "invalid arguments", tool: "write", args: { path: "x.txt" }, error: /Validation failed/ },
]) test(`${scenario.name} becomes a paired error result and the model can recover`, async (t) => {
	const { harness, agent } = createTestHarness(t, [
		{ toolCalls: [{ id: "bad", name: scenario.tool, arguments: scenario.args }] }, { text: "recovered" },
	]);
	await harness.prompt("go");
	const result = agent.state.messages.find((message) => message.role === "toolResult");
	assert.ok(result?.role === "toolResult" && result.isError);
	assert.equal(result.toolCallId, "bad");
	assert.match(messageText(result), scenario.error);
	assert.equal(messageText(agent.state.messages.at(-1)), "recovered");
});

test("a throwing tool reports failure without leaving pending calls", async (t) => {
	const tool: AgentTool = { name: "fail", label: "Fail", description: "Fail", parameters: Type.Object({}),
		execute: async () => { throw new Error("fixture tool failure"); } };
	const { harness, agent, events } = createTestHarness(t, [
		{ toolCalls: [{ id: "failure", name: "fail", arguments: {} }] }, { text: "handled" },
	], { tools: [tool] });
	await harness.prompt("go");
	const result = agent.state.messages.find((message) => message.role === "toolResult");
	assert.ok(result?.role === "toolResult" && result.isError);
	assert.match(messageText(result), /fixture tool failure/);
	assert.equal(events.filter((event) => event.type === "tool_execution_end" && event.isError).length, 1);
	assert.equal(agent.state.pendingToolCalls.size, 0);
});

test("truncated tool arguments are never executed and can be retried", async (t) => {
	let executions = 0;
	const tool: AgentTool = { name: "effect", label: "Effect", description: "Effect", parameters: Type.Object({}),
		execute: async () => { executions++; return { content: [], details: {} }; } };
	const { harness, agent } = createTestHarness(t, [
		{ stopReason: "length", toolCalls: [{ id: "truncated", name: "effect", arguments: {} }] }, { text: "retry completed" },
	], { tools: [tool] });
	await harness.prompt("go");
	assert.equal(executions, 0);
	const result = agent.state.messages.find((message) => message.role === "toolResult");
	assert.ok(result?.role === "toolResult" && result.isError);
	assert.match(messageText(result), /output token limit/);
	assert.equal(messageText(agent.state.messages.at(-1)), "retry completed");
});

test("stream and provider errors restore idle state and allow the next prompt", async (t) => {
	const { harness, agent } = createTestHarness(t, [
		() => { throw new Error("transport failed"); }, { error: "provider failed" }, { text: "healthy" },
	]);
	for (const error of [/transport failed/, /provider failed/]) {
		await harness.prompt("fail");
		assert.match(agent.state.errorMessage ?? "", error);
		assert.equal(agent.state.isStreaming, false);
		assert.equal(agent.state.pendingToolCalls.size, 0);
	}
	await harness.prompt("retry");
	assert.equal(agent.state.errorMessage, undefined);
	assert.equal(messageText(agent.state.messages.at(-1)), "healthy");
});

test("an active prompt rejects concurrent operations without changing its transcript", async (t) => {
	const started = deferred();
	const release = deferred();
	const tool: AgentTool = { name: "wait", label: "Wait", description: "Wait", parameters: Type.Object({}),
		execute: async () => { started.resolve(); await release.promise; return { content: [], details: {} }; } };
	const { harness, agent } = createTestHarness(t, [
		{ toolCalls: [{ id: "wait", name: "wait", arguments: {} }] }, { text: "finished" },
	], { tools: [tool] });
	const pending = harness.prompt("first");
	try {
		await started.promise;
		assert.equal(agent.state.isStreaming, true);
		await assert.rejects(harness.prompt("concurrent"), /processing/);
		assert.throws(() => harness.newSession(), /processing/);
		assert.throws(() => harness.setThinkingLevel("high"), /processing/);
		assert.throws(() => agent.reset(), /processing/);
		await assert.rejects(harness.manualCompact(), /processing/);
		assert.equal(agent.state.messages.filter((message) => message.role === "user").length, 1);
	} finally { release.resolve(); await pending; }
	await agent.waitForIdle();
	assert.equal(agent.state.isStreaming, false);
});

test("terminating permission policy prevents execution and follow-up model requests", async (t) => {
	const { harness, agent, scripted } = createTestHarness(t, [
		{ toolCalls: [{ id: "blocked", name: "write", arguments: { path: "blocked.txt", content: "no" } }] },
		{ text: "must remain queued" },
	]);
	harness.setBeforeToolCall(async () => ({ block: true, terminate: true, reason: "denied by test policy" }));
	await harness.prompt("go");
	assert.equal(scripted.requests.length, 1);
	assert.equal(scripted.pendingResponses, 1);
	const result = agent.state.messages.find((message) => message.role === "toolResult");
	assert.ok(result?.role === "toolResult" && result.isError);
	assert.match(messageText(result), /denied by test policy/);
});
