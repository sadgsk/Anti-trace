import assert from "node:assert/strict";
import test from "node:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Harness } from "../../src/harness/harness.ts";
import { streamModel } from "../../src/llm/adapter.ts";
import type { ModelApi } from "../../src/types.ts";
import { tempWorkspace } from "../support/fixtures.ts";
import { createHttpFixture, chatResponse } from "../support/http-server.ts";
import { writeSkill } from "../support/skills.ts";
import { testModel, messageText } from "../support/harness.ts";

type ObjectValue = Record<string, any>;
function nativeResponse(api: ModelApi, calls: boolean): string {
	const tools = [{ id: "skill-call", name: "skill", args: { skill: "review", args: "current" } }, { id: "read-call", name: "read", args: { path: "resource.txt" } }];
	if (api === "openai-completions") return calls
		? `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: tools.map((tool, index) => ({ index, id: tool.id, type: "function", function: { name: tool.name, arguments: JSON.stringify(tool.args) } })) }, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`
		: chatResponse("protocol skill complete");
	const events: ObjectValue[] = [];
	if (api === "openai-responses") {
		const items = calls ? tools.map(tool => ({ type: "function_call", id: `fc_${tool.id}`, call_id: tool.id, name: tool.name, arguments: JSON.stringify(tool.args), status: "completed" }))
			: [{ type: "message", id: "msg", role: "assistant", status: "completed", content: [{ type: "output_text", text: "protocol skill complete", annotations: [] }] }];
		events.push({ type: "response.created", response: { id: "response", status: "in_progress" } });
		items.forEach((item, output_index) => {
			events.push({ type: "response.output_item.added", output_index, item: { ...item, ...(item.type === "function_call" ? { arguments: "" } : { content: [] }) } });
			events.push({ type: "response.output_item.done", output_index, item });
		});
		events.push({ type: "response.completed", response: { id: "response", status: "completed", output: items, usage: { input_tokens: 100, output_tokens: 20 } } });
	} else {
		events.push({ type: "message_start", message: { id: "message", role: "assistant", content: [], usage: { input_tokens: 100 } } });
		const blocks = calls ? tools.map(tool => ({ type: "tool_use", id: tool.id, name: tool.name, input: tool.args })) : [{ type: "text", text: "protocol skill complete" }];
		blocks.forEach((block, index) => { events.push({ type: "content_block_start", index, content_block: block }); events.push({ type: "content_block_stop", index }); });
		events.push({ type: "message_delta", delta: { stop_reason: calls ? "tool_use" : "end_turn" }, usage: { output_tokens: 20 } }, { type: "message_stop" });
	}
	return events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
}

for (const api of ["openai-completions", "openai-responses", "anthropic-messages"] as const) test(`${api}: real wire exposes skill, receives calls, and sends paired results before instructions`, async t => {
	const root = tempWorkspace(t); writeSkill(root, "review", "PRIVATE_WIRE_SKILL_BODY: scope=$ARGUMENTS");
	writeFileSync(join(root, "resource.txt"), "WIRE_RESOURCE");
	const http = await createHttpFixture(t, (_request, response, index) => { response.writeHead(200, { "content-type": "text/event-stream" }).end(nativeResponse(api, index === 0)); });
	const harness = new Harness({ cwd: root, appHome: join(root, "app"), model: { ...testModel, api, baseUrl: http.url }, apiKey: "local-key", streamFn: streamModel });
	await harness.prompt("Review the current task");
	assert.equal(http.requests.length, 2, messageText(harness.agent.state.messages.at(-1)));
	const first = http.requests[0]!.body as ObjectValue, second = http.requests[1]!.body as ObjectValue;
	assert.equal(first.tools.filter((tool: ObjectValue) => (tool.function?.name ?? tool.name) === "skill").length, 1);
	assert.match(JSON.stringify(first), /review: Use review/);
	assert.doesNotMatch(JSON.stringify(first), /PRIVATE_WIRE_SKILL_BODY/);
	assert.match(JSON.stringify(second), /PRIVATE_WIRE_SKILL_BODY: scope=current/);
	assert.match(JSON.stringify(second), /WIRE_RESOURCE/);
	if (api === "openai-completions") {
		const messages = second.messages as ObjectValue[];
		assert.deepEqual(messages.filter(message => message.role === "tool").map(message => message.tool_call_id), ["skill-call", "read-call"]);
		assert.ok(messages.findIndex(message => JSON.stringify(message).includes("PRIVATE_WIRE_SKILL_BODY")) > messages.findIndex(message => message.tool_call_id === "read-call"));
	} else if (api === "openai-responses") {
		const input = second.input as ObjectValue[];
		assert.deepEqual(input.filter(item => item.type === "function_call_output").map(item => item.call_id), ["skill-call", "read-call"]);
		assert.ok(input.findIndex(item => JSON.stringify(item).includes("PRIVATE_WIRE_SKILL_BODY")) > input.findIndex(item => item.type === "function_call_output" && item.call_id === "read-call"));
	} else {
		const blocks = (second.messages as ObjectValue[]).flatMap(message => message.content);
		assert.deepEqual(blocks.filter(block => block.type === "tool_result").map(block => block.tool_use_id), ["skill-call", "read-call"]);
		assert.ok(blocks.findIndex(block => block.type === "text" && block.text.includes("PRIVATE_WIRE_SKILL_BODY")) > blocks.findIndex(block => block.type === "tool_result" && block.tool_use_id === "read-call"));
	}
	assert.equal(harness.agent.state.messages.at(-1)?.role, "assistant");
	assert.equal(messageText(harness.agent.state.messages.at(-1)), "protocol skill complete");
});
