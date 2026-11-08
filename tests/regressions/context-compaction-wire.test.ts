import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { Harness } from "../../src/harness/harness.ts";
import { loadSession } from "../../src/harness/session.ts";
import { streamModel } from "../../src/llm/adapter.ts";
import type { Model, ModelApi } from "../../src/types.ts";
import { createHttpFixture } from "../support/http-server.ts";
import { tempWorkspace } from "../support/fixtures.ts";
import { assertToolPairs, historyTool } from "../support/compaction.ts";
import { messageText } from "../support/harness.ts";

type Obj = Record<string, any>;
const task = "Keep the exact active task: inspect and fix this issue.";
const sse = (events: Obj[]) => events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");

function response(api: ModelApi, step: number): string {
	const calls = step === 0 ? [{ id: "old-call", argument: "old" }] : step === 1 ? [{ id: "b", argument: "b" }, { id: "c", argument: "c" }] : [];
	const text = step === 2 ? "<summary>Old inspection complete. Continue the task using b and c.</summary>" : "final answer";
	const input = step === 1 ? 42000 : 100, output = 100;
	if (api === "openai-completions") {
		const delta = { reasoning_content: `reason-${step}`, ...(calls.length ? {
			tool_calls: calls.map((call, index) => ({ index, id: call.id, type: "function", function: { name: "history", arguments: JSON.stringify({ id: call.argument }) } })),
		} : { content: text }) };
		return `data: ${JSON.stringify({ choices: [{ delta, finish_reason: calls.length ? "tool_calls" : "stop" }], usage: { prompt_tokens: input, completion_tokens: output, total_tokens: input + output } })}\n\ndata: [DONE]\n\n`;
	}
	if (api === "openai-responses") {
		const thought = { type: "reasoning", id: `rs_${step}`, status: "completed", summary: [{ type: "summary_text", text: `reason-${step}` }], encrypted_content: `opaque-${step}` };
		const items: Obj[] = [thought, ...(calls.length ? calls.map(call => ({ type: "function_call", id: `fc_${call.id}`, call_id: call.id, name: "history", arguments: JSON.stringify({ id: call.argument }), status: "completed" }))
			: [{ type: "message", id: `msg_${step}`, role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] }])];
		return sse([
			...items.flatMap((item, output_index) => [
				{ type: "response.output_item.added", output_index, item: item.type === "reasoning" ? { type: "reasoning", id: item.id, summary: [] } : { ...item, ...(item.type === "function_call" ? { arguments: "" } : { content: [] }) } },
				{ type: "response.output_item.done", output_index, item },
			]),
			{ type: "response.completed", response: { status: "completed", output: items, usage: { input_tokens: input, output_tokens: output } } },
		]);
	}
	const blocks: Obj[] = [{ type: "thinking", thinking: `reason-${step}`, signature: `sig-${step}` }, ...(calls.length ? calls.map(call => ({ type: "tool_use", id: call.id, name: "history", input: { id: call.argument } })) : [{ type: "text", text }])];
	return sse([
		{ type: "message_start", message: { role: "assistant", content: [], usage: { input_tokens: input, output_tokens: 0 } } },
		...blocks.flatMap((block, index) => [{ type: "content_block_start", index, content_block: block }, { type: "content_block_stop", index }]),
		{ type: "message_delta", delta: { stop_reason: calls.length ? "tool_use" : "end_turn" }, usage: { output_tokens: output } },
		{ type: "message_stop" },
	]);
}

for (const api of ["openai-completions", "openai-responses", "anthropic-messages"] as const) test(`${api}: mid-task compaction sends paired retained tools and complete native thinking over HTTP`, async (t) => {
	const root = tempWorkspace(t);
	const server = await createHttpFixture(t, (request, res, index) => {
		assert.ok(index < 4, "compaction/recovery must not loop");
		const body = request.body as Obj;
		if (index === 3) {
			const wire = JSON.stringify(body);
			assert.match(wire, /Old inspection complete/);
			assert.equal(wire.split(task).length - 1, 1);
			assert.doesNotMatch(wire, /old-tool:|old-call|reason-0|opaque-0|sig-0/);
			if (api === "openai-completions") {
				const assistant = body.messages.find((message: Obj) => message.role === "assistant");
				assert.equal(assistant.reasoning_content, "reason-1");
				assert.deepEqual(assistant.tool_calls.map((call: Obj) => call.id), ["b", "c"]);
				assert.deepEqual(body.messages.filter((message: Obj) => message.role === "tool").map((message: Obj) => message.tool_call_id), ["b", "c"]);
			} else if (api === "openai-responses") {
				assert.equal(body.input.find((item: Obj) => item.type === "reasoning").encrypted_content, "opaque-1");
				assert.deepEqual(body.input.filter((item: Obj) => item.type === "function_call").map((item: Obj) => item.call_id), ["b", "c"]);
				assert.deepEqual(body.input.filter((item: Obj) => item.type === "function_call_output").map((item: Obj) => item.call_id), ["b", "c"]);
			} else {
				const assistant = body.messages.find((message: Obj) => message.role === "assistant");
				assert.deepEqual(assistant.content[0], { type: "thinking", thinking: "reason-1", signature: "sig-1" });
				assert.deepEqual(assistant.content.filter((block: Obj) => block.type === "tool_use").map((block: Obj) => block.id), ["b", "c"]);
				assert.deepEqual(body.messages.flatMap((message: Obj) => message.content).filter((block: Obj) => block.type === "tool_result").map((block: Obj) => block.tool_use_id), ["b", "c"]);
			}
		}
		res.writeHead(200, { "Content-Type": "text/event-stream" }); res.end(response(api, index));
	});
	const model: Model = { id: "wire-test", name: "Wire test", provider: "test", api, baseUrl: server.url, contextWindow: 60000, maxOutputTokens: 8192,
		adapter: api === "anthropic-messages" ? {
			thinking: { mode: "budget", format: "anthropic", budgets: { low: 1024, medium: 2048, high: 4096, xhigh: 8192, max: 16384 }, minBudget: 1024, answerReserveTokens: 1024 },
			thinkingSignature: "required", reasoningReplay: "required",
		} : { thinking: { mode: "effort", levels: ["low", "medium", "high"] }, reasoningReplay: "required", ...(api === "openai-responses" ? { responsesReasoning: "encrypted" } : {}) },
	};
	const calls: string[] = [];
	const harness = new Harness({ cwd: root, sessionsRoot: join(root, "sessions"), model, apiKey: "test-only", streamFn: streamModel, thinking: { enabled: true, effort: "low" } });
	harness.agent.state.tools = [historyTool(calls)];
	await harness.prompt(task);
	assert.equal(server.requests.length, 4);
	assert.deepEqual(calls, ["old", "b", "c"]);
	assert.equal(messageText(harness.agent.state.messages.at(-1)), "final answer");
	assertToolPairs(harness.agent.state.messages);
	assert.deepEqual(loadSession(harness.listSessions()[0]!.filePath).messages, harness.agent.state.messages);
});
