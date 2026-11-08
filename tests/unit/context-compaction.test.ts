import assert from "node:assert/strict";
import test from "node:test";
import { estimateMessagesTokens } from "../../src/harness/context.ts";
import { DEFAULT_COMPACTION_SETTINGS, findCutIndex, formatSummary, isContextOverflow, shouldCompact, summarizeConversation } from "../../src/harness/compaction.ts";
import type { AgentMessage, AssistantMessage } from "../../src/types.ts";
import { testModel } from "../support/harness.ts";
import { createScriptedModel } from "../support/scripted-model.ts";

const user = (text: string): AgentMessage => ({ role: "user", content: [{ type: "text", text }], timestamp: 0 });
const assistant = (text: string): AssistantMessage => ({ role: "assistant", content: [{ type: "text", text }], model: "test", stopReason: "stop", timestamp: 0 });

test("token estimates include images, thinking and tool arguments", () => {
	assert.equal(estimateMessagesTokens([]), 0);
	assert.equal(estimateMessagesTokens([user("abcd")] ), 1);
	assert.equal(estimateMessagesTokens([{ role: "user", content: [{ type: "image", mimeType: "image/png", data: "x" }], timestamp: 0 }]), 1200);
	const rich: AssistantMessage = { ...assistant(""), content: [{ type: "thinking", thinking: "abcd" }, { type: "toolCall", id: "a", name: "read", arguments: { path: "a" } }] };
	assert.ok(estimateMessagesTokens([rich]) > 1);
});

test("automatic compaction uses a strict threshold and honors disabled settings", () => {
	const settings = { ...DEFAULT_COMPACTION_SETTINGS, reserveTokens: 100 };
	assert.equal(shouldCompact(900, 1000, settings), false);
	assert.equal(shouldCompact(901, 1000, settings), true);
	assert.equal(shouldCompact(2000, 1000, { ...settings, enabled: false }), false);
});

test("compaction cuts at a user turn without separating tool calls from their results", () => {
	const messages: AgentMessage[] = [user("x".repeat(400)), {
		...assistant(""), stopReason: "toolUse", content: [{ type: "toolCall", id: "a", name: "read", arguments: {} }],
	}, { role: "toolResult", toolCallId: "a", toolName: "read", content: [{ type: "text", text: "result" }], isError: false, timestamp: 0 },
	user("recent"), assistant("reply")];
	assert.equal(findCutIndex(messages, 2), 3);
	assert.equal(findCutIndex(messages, 10000), 0);
	assert.equal(findCutIndex(messages, 0), messages.length);
});

test("overflow detection distinguishes context exhaustion from ordinary output truncation", () => {
	assert.equal(isContextOverflow({ ...assistant(""), stopReason: "error", errorMessage: "maximum context length exceeded" }, 1000), true);
	assert.equal(isContextOverflow({ ...assistant(""), stopReason: "error", errorMessage: "HTTP 401" }, 1000), false);
	assert.equal(isContextOverflow({ ...assistant(""), stopReason: "length", usage: { input: 1000, output: 0 } }, 1000), true);
	assert.equal(isContextOverflow({ ...assistant("visible output"), stopReason: "length", usage: { input: 1000, output: 10 } }, 1000), false);
});

test("summary formatting removes analysis and retains untagged fallback text", () => {
	assert.equal(formatSummary("<analysis>private draft</analysis><summary> useful </summary>"), "Summary:\nuseful");
	assert.equal(formatSummary(" plain summary "), "plain summary");
	assert.equal(formatSummary(undefined), "");
});

test("summary tool retry refreshes credentials without modifying the live conversation", async () => {
	const scripted = createScriptedModel([{ toolCalls: [{ id: "ignored", name: "read", arguments: {} }] }, { text: "<summary>saved</summary>" }]);
	const messages = [user("history")], before = structuredClone(messages);
	let key = 0;
	const summary = await summarizeConversation({ model: testModel, streamFn: scripted.streamFn, context: { messages }, reserveTokens: 1000, getApiKey: () => `key-${++key}` });
	assert.equal(summary, "Summary:\nsaved");
	assert.deepEqual(messages, before);
	assert.deepEqual(scripted.requests.map((request) => request.options?.apiKey), ["key-1", "key-2"]);
	assert.equal(scripted.requests[1]!.options?.maxTokens, 800);
	assert.match(JSON.stringify(scripted.requests[1]!.context.messages.at(-1)), /previous attempt called a tool/);
});

for (const [name, turn, error] of [
	["provider error", { error: "summary failed" }, /summary failed/],
	["empty summary", { text: "" }, /empty/],
	["truncated summary", { text: "partial", stopReason: "length" }, /output limit/],
] as const) test(`summary rejects ${name}`, async () => {
	const scripted = createScriptedModel([turn]);
	await assert.rejects(summarizeConversation({ model: testModel, streamFn: scripted.streamFn, context: { messages: [] }, reserveTokens: 1000 }), error);
});
