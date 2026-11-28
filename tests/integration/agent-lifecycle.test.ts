import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { Type } from "typebox";
import type { AgentTool, AgentToolResult } from "../../src/types.ts";
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
	const ended = events.filter(event => event.type === "tool_execution_end");
	assert.equal(ended.length, 1);
	assert.equal(ended[0]!.isError, true);
	assert.equal((ended[0]!.result as AgentToolResult).isError, true);
	assert.equal(agent.state.pendingToolCalls.size, 0);
});

test("afterToolCall overrides a resolved tool's error flag consistently in the event and the next model request", async t => {
	const tool: AgentTool = {
		name: "check", label: "Check", description: "Check status", parameters: Type.Object({}),
		async execute(id) {
			return { content: [{ type: "text", text: id }], details: {}, isError: id === "recovered" };
		},
	};
	const ids = ["recovered", "rejected"];
	const { harness, agent, events, scripted } = createTestHarness(t, [
		{ toolCalls: ids.map(id => ({ id, name: "check", arguments: {} })) }, { text: "done" },
	], { tools: [tool] });
	const seen: unknown[] = [];
	agent.afterToolCall = async ({ result, isError, toolCall }) => {
		seen.push([toolCall.id, result.isError, isError]);
		return { isError: !isError };
	};
	await harness.prompt("check");
	assert.deepEqual(seen, [["recovered", true, true], ["rejected", false, false]]);
	const ended = events.filter(event => event.type === "tool_execution_end");
	assert.deepEqual(ended.map(event => [event.toolCallId, (event.result as AgentToolResult).isError, event.isError]),
		[["recovered", false, false], ["rejected", true, true]]);
	const sent = scripted.requests[1]!.context.messages.filter(message => message.role === "toolResult");
	assert.deepEqual(sent.map(message => [message.toolCallId, message.isError]), [["recovered", false], ["rejected", true]]);
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

test("file scheduling, approval, transcript, and actual edits agree when observers mutate arguments", async t => {
	const input = { path: "target.txt", edits: [{ oldText: "before", newText: "after" }] };
	const { harness, agent, root } = createTestHarness(t, [
		{ toolCalls: [{ id: "edit", name: "edit", arguments: structuredClone(input) }] }, { text: "done" },
	]);
	for (const file of ["target.txt", "other.txt"]) writeFileSync(join(root, file), "before");
	harness.subscribe(event => {
		if (event.type !== "tool_execution_start") return;
		const display = event.args as typeof input;
		display.path = "other.txt";
		display.edits[0]!.newText = "event";
	});
	const approved: unknown[] = [];
	harness.setBeforeToolCall(async (context, signal) => {
		await context.reserveForApproval!(signal!);
		const args = context.args as typeof input;
		Reflect.set(args, "path", "other.txt");
		Reflect.set(args.edits[0]!, "newText", "hook");
		Reflect.set(context.toolCall.arguments, "path", "other.txt");
		Reflect.set(context, "args", { ...args, path: "other.txt" });
		return undefined;
	});
	harness.setBeforeToolCall(async ({ args, toolCall }) => {
		approved.push(structuredClone(args), structuredClone(toolCall.arguments));
		return undefined;
	});
	await harness.prompt("edit target");
	assert.deepEqual(approved, [input, input]);
	assert.equal(readFileSync(join(root, "target.txt"), "utf8"), "after");
	assert.equal(readFileSync(join(root, "other.txt"), "utf8"), "before");
	const call = agent.state.messages.flatMap(message => message.role === "assistant" ? message.content : [])
		.find(block => block.type === "toolCall");
	assert.deepEqual(call?.arguments, input);
});

test("sequential beforeToolCall handlers can still adjust the tool's arguments", async t => {
	const { harness, agent, root } = createTestHarness(t, [
		{ toolCalls: [{ id: "write", name: "write", arguments: { path: "requested.txt", content: "done" } }] },
		{ text: "done" },
	]);
	agent.toolExecution = "sequential";
	harness.setBeforeToolCall(async ({ args }) => {
		(args as { path: string }).path = "redirected.txt";
		return undefined;
	});
	await harness.prompt("write");
	assert.equal(existsSync(join(root, "requested.txt")), false);
	assert.equal(readFileSync(join(root, "redirected.txt"), "utf8"), "done");
});
