import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { Harness } from "../../src/harness/harness.ts";
import { BASH_OUTPUT_MAX_BYTES } from "../../src/harness/tools/bash-output.ts";
import { streamModel } from "../../src/llm/adapter.ts";
import type { Model, ModelApi } from "../../src/types.ts";
import { tempWorkspace } from "../support/fixtures.ts";
import { createHttpFixture } from "../support/http-server.ts";
import { messageText } from "../support/harness.ts";

type Obj = Record<string, any>;
function response(api: ModelApi, call?: { id: string; name: string; arguments: Obj }): string {
	const args = JSON.stringify(call?.arguments);
	if (api === "openai-completions") {
		const delta = call ? { tool_calls: [{ index: 0, id: call.id, type: "function", function: { name: call.name, arguments: args } }] } : { content: "inspected middle log lines" };
		return `data: ${JSON.stringify({ choices: [{ delta, finish_reason: call ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`;
	}
	let events: Obj[];
	if (api === "openai-responses") {
		const item = call ? { type: "function_call", id: `fc_${call.id}`, call_id: call.id, name: call.name, arguments: args, status: "completed" }
			: { type: "message", id: "msg_done", role: "assistant", status: "completed", content: [{ type: "output_text", text: "inspected middle log lines", annotations: [] }] };
		events = [
			{ type: "response.created", response: { id: "resp_test", status: "in_progress" } },
			{ type: "response.output_item.added", output_index: 0, item: call ? { ...item, arguments: "" } : { ...item, content: [] } },
			...(call ? [{ type: "response.function_call_arguments.delta", output_index: 0, item_id: item.id, delta: args }]
				: [{ type: "response.content_part.added", output_index: 0, item_id: item.id, content_index: 0, part: { type: "output_text", text: "" } },
					{ type: "response.output_text.delta", output_index: 0, item_id: item.id, content_index: 0, delta: "inspected middle log lines" }]),
			{ type: "response.output_item.done", output_index: 0, item },
			{ type: "response.completed", response: { status: "completed", output: [item], usage: { input_tokens: 100, output_tokens: 10 } } },
		];
	} else {
		events = [
			{ type: "message_start", message: { role: "assistant", content: [], usage: { input_tokens: 100, output_tokens: 0 } } },
			{ type: "content_block_start", index: 0, content_block: call ? { type: "tool_use", id: call.id, name: call.name, input: {} } : { type: "text", text: "" } },
			{ type: "content_block_delta", index: 0, delta: call ? { type: "input_json_delta", partial_json: args } : { type: "text_delta", text: "inspected middle log lines" } },
			{ type: "content_block_stop", index: 0 },
			{ type: "message_delta", delta: { stop_reason: call ? "tool_use" : "end_turn" }, usage: { output_tokens: 10 } },
			{ type: "message_stop" },
		];
	}
	return events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
}

function toolReply(api: ModelApi, body: Obj, callId: string): string {
	if (api === "openai-completions") return body.messages.find((message: Obj) => message.role === "tool" && message.tool_call_id === callId)?.content;
	if (api === "openai-responses") {
		const output = body.input.find((item: Obj) => item.type === "function_call_output" && item.call_id === callId)?.output;
		return typeof output === "string" ? output : output?.map((part: Obj) => part.text ?? "").join("");
	}
	const block = body.messages.flatMap((message: Obj) => Array.isArray(message.content) ? message.content : [])
		.find((part: Obj) => part.type === "tool_result" && part.tool_use_id === callId);
	return typeof block?.content === "string" ? block.content : block?.content.map((part: Obj) => part.text ?? "").join("");
}

for (const api of ["openai-completions", "openai-responses", "anthropic-messages"] as const) {
	test(`${api}: bounded bash metadata reaches the wire and read retrieves omitted middle lines`, async (t) => {
		const root = tempWorkspace(t);
		const lines = Array.from({ length: 12000 }, (_, i) => `line-${String(i + 1).padStart(5, "0")}: ${"payload ".repeat(8)}`);
		lines[5999] = "MIDDLE-ONLY-DIAGNOSTIC: failure stack begins here";
		const original = lines.join("\n"), input = join(root, "source.log"), script = join(root, "emit.cjs");
		writeFileSync(input, original);
		writeFileSync(script, `require('node:fs').createReadStream(${JSON.stringify(input)}).pipe(process.stdout);`);
		const command = `"${process.execPath}" "${script}"`;
		let savedPath: string | undefined;
		const server = await createHttpFixture(t, (request, res, index) => {
			res.writeHead(200, { "Content-Type": "text/event-stream" });
			if (index === 0) {
				res.end(response(api, { id: "bash_call", name: "bash", arguments: { command } }));
			} else if (index === 1) {
				const output = toolReply(api, request.body as Obj, "bash_call");
				assert.equal(typeof output, "string");
				const match = /\n\[bash_result\]\n([^\n]+)\n\[\/bash_result\]/.exec(output);
				assert.ok(match, "actual HTTP tool reply must contain metadata, not just internal details");
				const meta = JSON.parse(match[1]!) as Obj;
				assert.equal(meta.truncated, true);
				assert.equal(meta.totalBytes, Buffer.byteLength(original));
				assert.equal(meta.exitCode, 0);
				assert.equal(meta.timedOut, false);
				assert.ok(meta.returnedBytes <= BASH_OUTPUT_MAX_BYTES);
				assert.equal(meta.returnedByteRanges.length, 2);
				assert.ok(Buffer.byteLength(output) < BASH_OUTPUT_MAX_BYTES + 2048);
				assert.doesNotMatch(output, /MIDDLE-ONLY-DIAGNOSTIC/);
				savedPath = meta.outputPath;
				assert.equal(readFileSync(savedPath!, "utf8"), original, "log is complete and flushed before the model receives its path");
				res.end(response(api, { id: "read_call", name: "read", arguments: { path: savedPath, offset: 5999, limit: 3 } }));
			} else {
				assert.equal(index, 2, "exactly one follow-up read is needed");
				const output = toolReply(api, request.body as Obj, "read_call");
				assert.match(output, /6000\|MIDDLE-ONLY-DIAGNOSTIC: failure stack begins here/);
				assert.ok(output.includes(lines[5998]!) && output.includes(lines[6000]!));
				assert.ok(output.length < 1000);
				res.end(response(api));
			}
		});
		const model: Model = { api, baseUrl: server.url, id: "fixture", provider: "local", name: "Fixture",
			contextWindow: 128000, maxOutputTokens: 2000 };
		const harness = new Harness({ cwd: root, sessionsRoot: join(root, "sessions"), streamFn: streamModel, model, apiKey: "fake-test-key" });
		t.after(async () => { harness.abort(); await harness.agent.waitForIdle(); });
		await harness.prompt("Run the command, inspect the saved middle log lines, and report the result.");
		assert.equal(server.requests.length, 3);
		assert.equal(messageText(harness.agent.state.messages.at(-1)), "inspected middle log lines");
		assert.ok(savedPath);
		assert.equal(harness.agent.state.pendingToolCalls.size, 0);
	});
}
