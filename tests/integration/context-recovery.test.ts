import assert from "node:assert/strict";
import test from "node:test";
import { loadSession } from "../../src/harness/session.ts";
import { estimateContextTokens } from "../../src/harness/context.ts";
import { DEFAULT_COMPACTION_SETTINGS } from "../../src/harness/compaction.ts";
import type { AgentMessage } from "../../src/types.ts";
import { createTestHarness, messageText, testModel } from "../support/harness.ts";
import { assertToolPairs, historyTool, seedCompactionHistory } from "../support/compaction.ts";
import { deferred } from "../support/fixtures.ts";
import type { ResponseStep } from "../support/scripted-model.ts";

for (const offset of [1, 0, -1]) test(`request preflight respects the threshold boundary (window offset ${offset})`, async (t) => {
	const compact = offset < 0;
	const steps: ResponseStep[] = [{ text: "old answer" }];
	if (compact) steps.push({ text: "<summary>short</summary>" });
	steps.push({ text: "accepted" });
	const { harness, agent, scripted, events } = createTestHarness(t, steps);
	await seedCompactionHistory(harness);
	const task: AgentMessage = { role: "user", content: [{ type: "text", text: "current" }], timestamp: 0 };
	const used = estimateContextTokens({ systemPrompt: agent.state.systemPrompt, tools: agent.state.tools, messages: [...agent.state.messages, task] });
	harness.setContextWindow(used + DEFAULT_COMPACTION_SETTINGS.reserveTokens + offset);
	events.length = 0;
	await harness.prompt("current");
	assert.equal(scripted.requests.length, compact ? 3 : 2);
	assert.equal(events.filter(event => event.type === "compaction_end").length, Number(compact));
	assert.equal(scripted.pendingResponses, 0);
	const sent = scripted.requests.at(-1)!.context.messages;
	assert.equal(sent.filter(message => message.role === "user" && messageText(message) === "current").length, 1);
	assert.equal(messageText(agent.state.messages.at(-1)), "accepted");
	if (compact) assert.match(messageText(sent[0]), /Summary:\nshort/);
	assert.deepEqual(loadSession(harness.listSessions()[0]!.filePath).messages, agent.state.messages);
	assert.deepEqual(events.filter(event => event.type === "prompt_end").map(event => event.result), [{ status: "success" }]);
});

test("one user task compacts between tool rounds, retaining complete multi-tool results and the task verbatim", async (t) => {
	const calls: string[] = [];
	const { harness, agent, scripted, events } = createTestHarness(t, [
		{ toolCalls: [{ id: "old-call", name: "history", arguments: { id: "old" } }], usage: { input: 100, output: 20 } },
		{ toolCalls: [{ id: "b", name: "history", arguments: { id: "b" } }, { id: "c", name: "history", arguments: { id: "c" } }], usage: { input: 42000, output: 100 } },
		{ text: "<summary>Old inspection complete; continue with b and c.</summary>" },
		{ toolCalls: [{ id: "d", name: "history", arguments: { id: "d" } }] },
		{ text: "done", usage: { input: 1500, output: 5 } },
	], { model: { ...testModel, contextWindow: 60000 }, tools: [historyTool(calls)] });
	await harness.prompt("Keep this task exactly; inspect and fix the issue.");
	assert.deepEqual(calls, ["old", "b", "c", "d"]);
	assert.equal(scripted.requests.length, 5, "summary precedes continuation and stale retained usage must not retrigger compaction");
	const continuation = scripted.requests[3]!.context.messages;
	assert.match(messageText(continuation[0]), /Old inspection complete/);
	assert.equal(continuation.filter(message => message.role === "user" && messageText(message) === "Keep this task exactly; inspect and fix the issue.").length, 1);
	assert.equal(continuation.some(message => message.role === "toolResult" && message.toolCallId === "old-call"), false);
	assert.deepEqual(continuation.filter(message => message.role === "toolResult").map(message => message.toolCallId), ["b", "c"]);
	assertToolPairs(continuation);
	assertToolPairs(agent.state.messages);
	const loaded = loadSession(harness.listSessions()[0]!.filePath);
	assert.deepEqual(loaded.messages, agent.state.messages);
	assert.equal(loaded.entries.filter(entry => entry.type === "compaction").length, 1);
	assert.equal(events.filter(event => event.type === "agent_end").length, 1);
	assert.deepEqual(events.filter(event => event.type === "prompt_end").map(event => event.result), [{ status: "success" }]);
});

for (const kind of ["error", "length"] as const) test(`server overflow (${kind}) recovers once and preserves live/persisted context`, async (t) => {
	const overflow: ResponseStep = kind === "error" ? { error: "Your input exceeds the context window" }
		: { stopReason: "length", usage: { input: testModel.contextWindow, output: 0 } };
	const { harness, agent, scripted, events } = createTestHarness(t, [
		{ text: "old answer" }, overflow, { text: "<summary>recovered history</summary>" }, { text: "recovered", usage: { input: 1200, output: 5 } },
	]);
	await seedCompactionHistory(harness);
	events.length = 0;
	await harness.prompt("current");
	assert.equal(scripted.requests.length, 4);
	assert.equal(scripted.pendingResponses, 0);
	assert.equal(messageText(agent.state.messages.at(-1)), "recovered");
	assert.equal(agent.state.messages.filter(message => message.role === "user" && messageText(message) === "current").length, 1);
	assert.deepEqual(loadSession(harness.listSessions()[0]!.filePath).messages, agent.state.messages);
	assert.equal(events.filter(event => event.type === "agent_end").length, 2);
	assert.deepEqual(events.filter(event => event.type === "prompt_end").map(event => event.result), [{ status: "success" }]);
});

test("failed summary restores the failed request and reports the actual error once", async (t) => {
	const { harness, agent, events, scripted } = createTestHarness(t, [
		{ text: "old answer" }, { error: "maximum context length exceeded" }, { error: "summary provider failed" },
	]);
	await seedCompactionHistory(harness);
	const before = structuredClone(agent.state.messages);
	events.length = 0;
	await assert.rejects(harness.prompt("current"), /summary provider failed/);
	assert.deepEqual(agent.state.messages.slice(0, before.length), before);
	assert.equal(agent.state.messages.at(-1)?.role, "assistant");
	assert.deepEqual(loadSession(harness.listSessions()[0]!.filePath).messages, agent.state.messages);
	assert.equal(events.filter(event => event.type === "compaction_end").length, 0);
	const ends = events.filter(event => event.type === "prompt_end");
	assert.equal(ends.length, 1);
	assert.equal(ends[0]!.result.status, "error");
	assert.match("message" in ends[0]!.result ? ends[0]!.result.message : "", /summary provider failed/);
	assert.equal(scripted.pendingResponses, 0);
});

test("preflight summary tool retry refreshes keys without executing the tool or recursing", async (t) => {
	const { harness, agent, scripted, events } = createTestHarness(t, [
		{ text: "old answer" }, { toolCalls: [{ id: "ignored", name: "write", arguments: { path: "must-not-exist", content: "bad" } }] },
		{ text: "<summary>short</summary>" }, { text: "continued" },
	]);
	await seedCompactionHistory(harness);
	harness.setContextWindow(40000);
	let key = 0;
	harness.configureModel({ model: { ...testModel, contextWindow: 40000 }, getApiKey: () => `key-${++key}` });
	events.length = 0;
	await harness.prompt("current");
	assert.deepEqual(scripted.requests.slice(1).map(request => request.options?.apiKey), ["key-1", "key-2", "key-3"]);
	assert.equal(events.filter(event => event.type === "tool_execution_start").length, 0);
	assert.equal(events.filter(event => event.type === "compaction_start").length, 1);
	assert.equal(messageText(agent.state.messages.at(-1)), "continued");
	assert.equal(scripted.pendingResponses, 0);
});

test("preflight compaction uses the next turn's explicit model, window and thinking snapshot", async (t) => {
	const calls: string[] = [];
	const { harness, agent, scripted } = createTestHarness(t, [
		{ toolCalls: [{ id: "old-call", name: "history", arguments: { id: "old" } }] },
		{ text: "<summary>Inspection complete.</summary>" }, { text: "continued with override" },
	], { tools: [historyTool(calls)] });
	agent.prepareNextTurn = ({ toolResults }) => toolResults.length ? {
		model: { ...testModel, id: "override-model", contextWindow: 40000, maxOutputTokens: 1024 },
		thinking: { enabled: false, effort: "low" },
	} : undefined;
	await harness.prompt("current task");
	assert.equal(scripted.requests.length, 3);
	for (const request of scripted.requests.slice(1)) {
		assert.equal(request.model.id, "override-model");
		assert.equal(request.model.contextWindow, 40000);
		assert.equal(request.options?.maxTokens, 1024);
		assert.deepEqual(request.options?.thinking, { enabled: false, effort: "low" });
	}
	assert.equal(agent.state.model?.id, testModel.id, "the explicit override applies only within this run");
	assert.equal(messageText(agent.state.messages.at(-1)), "continued with override");
});

test("cancelling a pending preflight summary does not commit late output and the next prompt can run", async (t) => {
	const entered = deferred(), release = deferred();
	const { harness, agent, scripted, events } = createTestHarness(t, [
		{ text: "old answer" }, async () => { entered.resolve(); await release.promise; return { text: "<summary>late summary</summary>" }; },
	]);
	await seedCompactionHistory(harness);
	harness.setContextWindow(40000);
	const before = structuredClone(agent.state.messages);
	events.length = 0;
	const pending = harness.prompt("cancelled task");
	try {
		await entered.promise;
		assert.throws(() => harness.newSession(), /processing/);
		await assert.rejects(harness.compact(), /processing/);
		harness.abort(); release.resolve();
		await pending;
		assert.deepEqual(agent.state.messages.slice(0, before.length), before);
		assert.equal(events.filter(event => event.type === "compaction_end").length, 0);
		assert.equal(events.filter(event => event.type === "prompt_end" && event.result.status === "aborted").length, 1);
		assert.equal(loadSession(harness.listSessions()[0]!.filePath).entries.some(entry => entry.type === "compaction"), false);
		harness.setContextWindow(128000);
		scripted.appendResponses({ text: "next task succeeds" });
		await harness.prompt("next task");
		assert.equal(messageText(agent.state.messages.at(-1)), "next task succeeds");
	} finally { release.resolve(); await pending.catch(() => {}); }
});
