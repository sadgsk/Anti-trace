import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { Type } from "typebox";
import { Agent } from "../../src/agent/agent.ts";
import { Harness } from "../../src/harness/harness.ts";
import { runCli } from "../../src/cli/main.ts";
import { loadByokConfig } from "../../src/config/byok.ts";
import { streamModel } from "../../src/llm/adapter.ts";
import { validateAdapterForApi } from "../../src/llm/rules.ts";
import { appendEntry, createSessionFile, loadSession } from "../../src/harness/session.ts";
import type { AssistantMessage, AssistantMessageEvent, Context, Model, ModelApi, StreamOptions, ThinkingLevel } from "../../src/types.ts";

type Obj = Record<string, any>;
type Request = { body: Obj; headers: Obj; path: string };
const protocols = ["openai-responses", "anthropic-messages"] as const;
const levels: ThinkingLevel[] = ["low", "medium", "high", "xhigh", "max"];
const sse = (events: Obj[]) => events.map(event => `event: ${event.type}\r\ndata: ${JSON.stringify(event)}\r\n\r\n`).join("");
const rText = (text = "你好") => ({ type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] });
const rThink = () => ({ type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: "想一想" }], encrypted_content: "opaque+/==" });
const rTool = (id = "call_1", args = '{"n":1}') => ({ type: "function_call", id: `fc_${id}`, call_id: id, name: "echo", arguments: args, status: "completed" });
function responses(items: Obj[] = [rText()], reason?: string): Obj[] {
	const events: Obj[] = [{ type: "response.created", response: { id: "resp_1", status: "in_progress" } }];
	items.forEach((item, output_index) => {
		events.push({ type: "response.output_item.added", output_index, item: { ...item, ...(item.type === "message" ? { content: [] } : item.type === "reasoning" ? { summary: [], encrypted_content: null } : { arguments: "" }) } });
		if (item.type === "message") item.content.forEach((part: Obj, content_index: number) => {
			events.push({ type: "response.content_part.added", output_index, item_id: item.id, content_index, part: { ...part, text: "" } });
			for (const delta of [...part.text]) events.push({ type: "response.output_text.delta", output_index, item_id: item.id, content_index, delta });
			events.push({ type: "response.output_text.done", output_index, item_id: item.id, content_index, text: part.text });
			events.push({ type: "response.content_part.done", output_index, item_id: item.id, content_index, part });
		});
		if (item.type === "reasoning") item.summary.forEach((part: Obj, summary_index: number) => {
			events.push({ type: "response.reasoning_summary_part.added", output_index, summary_index, part: { type: "summary_text", text: "" } });
			for (const delta of [...part.text]) events.push({ type: "response.reasoning_summary_text.delta", output_index, summary_index, delta });
			events.push({ type: "response.reasoning_summary_text.done", output_index, summary_index, text: part.text });
		});
		if (item.type === "function_call") for (const delta of [...item.arguments]) events.push({ type: "response.function_call_arguments.delta", output_index, item_id: item.id, delta });
		events.push({ type: "response.output_item.done", output_index, item });
	});
	events.push({ type: reason ? "response.incomplete" : "response.completed", response: { status: reason ? "incomplete" : "completed", output: items, ...(reason ? { incomplete_details: { reason } } : {}), usage: { input_tokens: 13, output_tokens: 7, total_tokens: 20 } } });
	return events;
}
const aThink = () => ({ type: "thinking", thinking: "想一想", signature: "sig+/==" });
const aTool = (id = "call_1", input: any = { n: 1 }) => ({ type: "tool_use", id, name: "echo", input });
function anthropic(items: Obj[] = [{ type: "text", text: "你好" }], reason?: string): Obj[] {
	const events: Obj[] = [{ type: "message_start", message: { role: "assistant", content: [], usage: { input_tokens: 10, cache_read_input_tokens: 20, cache_creation_input_tokens: 5, output_tokens: 1 } } }];
	items.forEach((item, index) => {
		events.push({ type: "content_block_start", index, content_block: { ...item, ...(item.type === "text" ? { text: "" } : item.type === "thinking" ? { thinking: "", signature: "" } : item.type === "tool_use" ? { input: {} } : {}) } });
		const value = item.type === "tool_use" ? JSON.stringify(item.input) : item.text ?? item.thinking;
		if (value !== undefined) for (const part of [...value]) events.push({ type: "content_block_delta", index, delta: item.type === "text" ? { type: "text_delta", text: part } : item.type === "thinking" ? { type: "thinking_delta", thinking: part } : { type: "input_json_delta", partial_json: part } });
		if (item.type === "thinking") {
			events.push({ type: "content_block_delta", index, delta: { type: "signature_delta", signature: item.signature.slice(0, 3) } });
			events.push({ type: "content_block_delta", index, delta: { type: "signature_delta", signature: item.signature.slice(3) } });
		}
		events.push({ type: "content_block_stop", index });
	});
	events.push({ type: "message_delta", delta: { stop_reason: reason ?? (items.some(item => item.type === "tool_use") ? "tool_use" : "end_turn") }, usage: { output_tokens: 7 } });
	events.push({ type: "message_stop" });
	return events;
}
const ok = (api: ModelApi) => api === "openai-responses" ? responses() : anthropic();
const thoughtAndTools = (api: ModelApi) => api === "openai-responses" ? responses([rThink(), rTool(), rTool("call_2", '{"n":2}')]) : anthropic([aThink(), { type: "redacted_thinking", data: "hidden+/==" }, aTool(), aTool("call_2", { n: 2 })]);
async function withHttp(respond: (res: ServerResponse, count: number, req: Request) => void, run: (url: string, requests: Request[]) => Promise<void>) {
	const requests: Request[] = [];
	const server = createServer(async (req, res) => {
		const parts: Buffer[] = [];
		for await (const chunk of req) parts.push(Buffer.from(chunk));
		const request = { body: JSON.parse(Buffer.concat(parts).toString()), headers: req.headers, path: req.url! };
		requests.push(request);
		respond(res, requests.length - 1, request);
	});
	await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
	try {
		const address = server.address(); assert.ok(address && typeof address === "object");
		await run(`http://127.0.0.1:${address.port}/v1`, requests);
	} finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}
function model(api: ModelApi, baseUrl: string): Model {
	return { api, baseUrl, id: api === "openai-responses" ? "gpt-5.1" : "claude-sonnet-4-5", provider: "local", name: "Test", contextWindow: 128000, maxOutputTokens: 32000, adapter: { preset: api === "openai-responses" ? "openai" : "anthropic" } };
}
const user: Context["messages"][number] = { role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1 };
async function collect(current: Model, options: StreamOptions = {}, context: Context = { messages: [user] }) {
	const stream = await streamModel(current, context, { apiKey: "fake-secret", ...options });
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) events.push(structuredClone(event));
	return { message: await stream.result(), events };
}
function temp() {
	const root = resolve(mkdtempSync(join(tmpdir(), "byok-native-")));
	return { root, cleanup() { assert.equal(dirname(root), resolve(tmpdir())); assert.ok(root.includes("byok-native-")); rmSync(root, { recursive: true, force: true }); } };
}

for (const api of protocols) {
	test(`${api}: five levels, off and server default reach native wire fields`, async () => {
		await withHttp(res => res.end(sse(ok(api))), async (url, requests) => {
			const current = model(api, url);
			for (const effort of levels) assert.equal((await collect(current, { thinking: { enabled: true, effort } })).message.stopReason, "stop");
			await collect(current, { thinking: { enabled: false, effort: "max" }, maxTokens: 2000 });
			await collect(current, { thinking: { effort: "high" } });
			if (api === "openai-responses") {
				assert.deepEqual(requests.slice(0, 5).map(r => r.body.reasoning.effort), ["low", "medium", "high", "high", "high"]);
				assert.deepEqual(requests[5].body.reasoning, { effort: "none" });
				assert.equal(requests[5].body.max_output_tokens, 2000);
				assert.equal(requests[6].body.reasoning, undefined);
				assert.equal(requests[0].body.store, false);
			} else {
				assert.deepEqual(requests.slice(0, 5).map(r => r.body.thinking.budget_tokens), [1024, 2048, 4096, 8192, 16384]);
				assert.deepEqual(requests[5].body.thinking, { type: "disabled" });
				assert.equal(requests[5].body.max_tokens, 2000);
				assert.equal(requests[6].body.thinking, undefined);
			}
		});
	});
	test(`${api}: UTF-8 byte splits, event order, complete native replay and usage`, async () => {
		await withHttp(res => { for (const byte of Buffer.from(sse(thoughtAndTools(api)))) res.write(Buffer.from([byte])); res.end(); }, async (url) => {
			const { message, events } = await collect(model(api, url));
			assert.equal(message.stopReason, "toolUse", message.errorMessage);
			assert.deepEqual(message.content.filter(b => b.type === "toolCall").map(b => [b.id, b.arguments]), [["call_1", { n: 1 }], ["call_2", { n: 2 }]]);
			assert.equal(message.content[0].type === "thinking" && message.content[0].thinking, "想一想");
			assert.equal(events.filter(e => e.type === "toolcall_end").length, 2);
			assert.equal(events.at(-1)?.type, "done");
			assert.equal(message.usage?.input, api === "openai-responses" ? 13 : 35);
			assert.equal(message.usage?.output, 7);
			const thought = message.content[0]; assert.equal(thought.type, "thinking");
			assert.ok(thought.replay);
			assert.equal(thought.replay.source.baseUrl, `${url}/${api === "openai-responses" ? "responses" : "messages"}`);
			assert.deepEqual(api === "openai-responses" ? thought.replay.payload.item : thought.replay.payload.block, api === "openai-responses" ? rThink() : aThink());
		});
	});
	test(`${api}: actual Agent executes two tools and passes results and native reasoning back`, async () => {
		await withHttp((res, n) => res.end(sse(n === 0 ? thoughtAndTools(api) : ok(api))), async (url, requests) => {
			const executed: number[] = [];
			const agent = new Agent({ streamFn: streamModel, apiKey: "fake-secret", initialState: { model: model(api, url), thinking: { enabled: true, effort: "medium" }, tools: [{ name: "echo", label: "echo", description: "echo", parameters: Type.Object({ n: Type.Number() }), async execute(_id, args) { assert.ok(args && typeof args === "object" && "n" in args); executed.push(Number(args.n)); return { content: [{ type: "text", text: `result ${args.n}` }], details: {} }; } }] } });
			await agent.prompt("use tools");
			assert.deepEqual(executed, [1, 2]);
			assert.equal(requests.length, 2);
			assert.equal((agent.state.messages.at(-1) as AssistantMessage).stopReason, "stop");
			if (api === "openai-responses") {
				assert.deepEqual(requests[1].body.input.find((b: Obj) => b.type === "reasoning"), rThink());
				assert.deepEqual(requests[1].body.input.filter((b: Obj) => b.type === "function_call_output").map((b: Obj) => b.call_id), ["call_1", "call_2"]);
				assert.equal(requests[0].body.tools[0].strict, false);
			} else {
				assert.deepEqual(requests[1].body.messages[1].content.slice(0, 2), [aThink(), { type: "redacted_thinking", data: "hidden+/==" }]);
				assert.deepEqual(requests[1].body.messages[2].content.map((b: Obj) => b.tool_use_id), ["call_1", "call_2"]);
				assert.equal(requests[1].headers["anthropic-version"], "2023-06-01");
				assert.equal(requests[1].headers["x-api-key"], "fake-secret");
				assert.equal(requests[1].headers.authorization, undefined);
			}
		});
	});
	test(`${api}: error, malformed JSON, EOF and trailing error discard tools and replay`, async () => {
		const full = thoughtAndTools(api);
		const cases = [sse(full.slice(0, -1)), sse(full) + sse([{ type: "error", error: { message: "fake-secret denied" } }]), 'data: {broken\n\n', sse([{ type: "error", error: { message: "remote failure" } }])];
		await withHttp((res, n) => res.end(cases[n]), async url => {
			for (const _ of cases) {
				const result = await collect(model(api, url));
				assert.equal(result.message.stopReason, "error");
				assert.ok(!result.message.content.some(b => b.type === "toolCall" || (b.type === "thinking" && b.replay)));
				assert.doesNotMatch(result.message.errorMessage!, /fake-secret/);
			}
		});
	});
	test(`${api}: output limit truncation retains visible content, removes tool calls and replay`, async () => {
		let events = api === "openai-responses" ? responses([rThink(), rTool("call_1", '{"x":')], "max_output_tokens") : anthropic([aThink(), aTool()], "max_tokens");
		if (api === "anthropic-messages") events = events.map(e => e.type === "content_block_delta" && e.delta.type === "input_json_delta" ? { ...e, delta: { ...e.delta, partial_json: "{" } } : e);
		await withHttp(res => res.end(sse(events)), async url => {
			const result = await collect(model(api, url));
			assert.equal(result.message.stopReason, "length", result.message.errorMessage);
			assert.ok(result.message.content.some(b => b.type === "thinking"));
			assert.ok(!result.message.content.some(b => b.type === "toolCall" || (b.type === "thinking" && b.replay)));
		});
	});
	test(`${api}: cancellation during thinking closes reader and never commits native replay`, async () => {
		const events = thoughtAndTools(api);
		const cut = events.findIndex(e => e.type.endsWith("text.delta") || e.delta?.type === "thinking_delta");
		await withHttp(res => res.write(sse(events.slice(0, cut + 1))), async url => {
			const controller = new AbortController();
			const stream = await streamModel(model(api, url), { messages: [user] }, { apiKey: "fake-secret", signal: controller.signal });
			for await (const event of stream) if (event.type === "thinking_delta") controller.abort();
			assert.equal((await stream.result()).stopReason, "aborted");
			assert.ok(!(await stream.result()).content.some(b => b.type === "thinking" && b.replay));
		});
	});
	test(`${api}: user and tool images preserve order, unsupported capabilities fail before HTTP`, async () => {
		await withHttp(res => res.end(sse(ok(api))), async (url, requests) => {
			const content = [{ type: "text" as const, text: "before" }, { type: "image" as const, mimeType: "image/png", data: "AAAA" }, { type: "text" as const, text: "after" }];
			const context: Context = { systemPrompt: "system", messages: [{ role: "user", content, timestamp: 1 }, { role: "assistant", model: "old", timestamp: 2, stopReason: "toolUse", content: [{ type: "toolCall", id: "bad:id/1", name: "echo", arguments: {} }] }, { role: "toolResult", toolCallId: "bad:id/1", toolName: "echo", content, isError: true, timestamp: 3 }] };
			assert.equal((await collect(model(api, url), {}, context)).message.stopReason, "stop");
			const body = requests[0].body;
			const wire = api === "openai-responses" ? body.input[2].output : body.messages[2].content[0].content;
			assert.deepEqual(wire.map((b: Obj) => b.type), api === "openai-responses" ? ["input_text", "input_image", "input_text"] : ["text", "image", "text"]);
			if (api === "openai-responses") assert.equal(body.input[1].call_id, body.input[2].call_id);
			else { assert.equal(body.messages[1].content[0].id, body.messages[2].content[0].tool_use_id); assert.equal(body.messages[2].content[0].is_error, true); }
			for (const capabilities of [{ images: false }, { tools: false }]) assert.equal((await collect({ ...model(api, url), capabilities }, {}, context)).message.stopReason, "error");
			assert.equal(requests.length, 1);
		});
	});
	test(`${api}: same-source replay survives JSONL, changed endpoint/model/provider omits opaque history`, async () => {
		await withHttp((res, n) => res.end(sse(n === 0 ? thoughtAndTools(api) : ok(api))), async (url, requests) => {
			const current = model(api, url);
			const original = (await collect(current)).message;
			const f = temp();
			try {
				const session = createSessionFile(f.root, join(f.root, "sessions"));
				appendEntry(session, { type: "message", message: user }); appendEntry(session, { type: "message", message: original });
				const loaded = loadSession(session.path);
				assert.deepEqual(loaded.messages, [user, original]);
				const persisted = readFileSync(session.path, "utf8"); assert.doesNotMatch(persisted, /fake-secret|x-api-key|Authorization/);
				const message = JSON.parse(persisted.trim().split("\n").at(-1)!).message as AssistantMessage;
				assert.deepEqual(message, original);
				const context: Context = { messages: [...loaded.messages as Context["messages"], { ...user, timestamp: 3 }] };
				const snapshot = JSON.stringify(context);
				await collect(current, {}, context);
				assert.match(JSON.stringify(requests[1].body), /opaque|sig\+/);
				for (const override of [{ endpoint: `${url}/other` }, { id: "different" }, { provider: "different" }]) {
					await collect({ ...current, ...override }, {}, context);
					assert.doesNotMatch(JSON.stringify(requests.at(-1)!.body), /opaque|sig\+|hidden\+/);
				}
				assert.equal(JSON.stringify(context), snapshot);
			} finally { f.cleanup(); }
		});
	});
	test(`${api}: CLI loads protocol config, persists reply, request failures remain recoverable`, async () => {
		await withHttp((res, n) => { if (n === 0) { res.writeHead(401); res.end('denied'); } else res.end(sse(ok(api))); }, async url => {
			const f = temp();
			try {
				writeFileSync(join(f.root, "byok.json"), JSON.stringify({ version: 1, connections: { local: { api, baseUrl: url, apiKey: "fake-secret" } }, models: { main: { connection: "local", id: model(api, url).id, contextWindow: 128000, maxOutputTokens: 32000, adapter: model(api, url).adapter } }, currentModel: "main" }));
				const loaded = loadByokConfig({ cwd: f.root, configPath: join(f.root, "byok.json") }); assert.equal(loaded.model.api, api);
				const harness = new Harness({ cwd: f.root, sessionsRoot: join(f.root, "sessions"), model: loaded.model, getApiKey: loaded.getApiKey, streamFn: streamModel });
				await harness.prompt("first"); assert.equal((harness.agent.state.messages.at(-1) as AssistantMessage).stopReason, "error");
				await harness.prompt("second"); assert.equal((harness.agent.state.messages.at(-1) as AssistantMessage).stopReason, "stop");
				const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough(); let text = ""; stdout.on("data", b => text += b);
				stdin.end("CLI"); assert.equal(await runCli({ cwd: f.root, configPath: join(f.root, "byok.json"), sessionsRoot: join(f.root, "sessions"), streams: { stdin, stdout, stderr } }), 0); assert.match(text, /你好/);
			} finally { f.cleanup(); }
		});
	});
}

test("Anthropic adaptive effort repeats native max; budget clamps with headroom and rejects too-small output", async () => {
	await withHttp(res => res.end(sse(anthropic())), async (url, requests) => {
		for (const id of ["claude-opus-4-6", "claude-sonnet-4-6"]) {
			for (const effort of levels) await collect({ ...model("anthropic-messages", url), id }, { thinking: { enabled: true, effort } });
			assert.deepEqual(requests.slice(-5).map(r => r.body.output_config.effort), ["low", "medium", "high", "max", "max"]);
			assert.ok(requests.slice(-5).every(r => r.body.thinking.type === "adaptive" && r.body.thinking.budget_tokens === undefined));
		}
		const current = model("anthropic-messages", url);
		await collect(current, { maxTokens: 4000, thinking: { enabled: true, effort: "max" } });
		assert.equal(requests.at(-1)!.body.thinking.budget_tokens, 2976);
		const count = requests.length;
		assert.equal((await collect(current, { maxTokens: 2047, thinking: { enabled: true, effort: "low" } })).message.stopReason, "error");
		assert.equal(requests.length, count);
		// Messages has a documented default output limit when maxOutputTokens is absent.
		assert.equal((await collect({ ...current, maxOutputTokens: undefined })).message.stopReason, "stop");
		assert.equal(requests.at(-1)!.body.max_tokens, 32000);
	});
});

test("protocol-specific adapter validation rejects conflicting fields and accepts explicit custom templates", () => {
	assert.throws(() => validateAdapterForApi({ includeUsage: false }, "openai-responses"));
	assert.doesNotThrow(() => validateAdapterForApi({ thinking: { mode: "effort", levels: ["low"] } }, "anthropic-messages"));
	assert.throws(() => validateAdapterForApi({ thinking: { mode: "effort", levels: ["low"], off: "none" } }, "anthropic-messages"));
	assert.throws(() => validateAdapterForApi({ thinking: { mode: "adaptive", levels: ["high"] } }, "openai-completions"));
	assert.throws(() => validateAdapterForApi({ preset: "anthropic" }, "openai-responses"));
	assert.doesNotThrow(() => validateAdapterForApi({ thinking: { mode: "adaptive", levels: ["low", "high"], canDisable: false } }, "anthropic-messages"));
});

test("Responses reasoning summary, multi-part summary, opaque-only thinking and terminal-only text", async () => {
	const think = { ...rThink(), summary: [{ type: "summary_text", text: "one" }, { type: "summary_text", text: "two" }] };
	const cases = [responses([think, rText()]), responses([{ ...rThink(), summary: [] }]), [responses().at(-1)!]];
	await withHttp((res, n) => res.end(sse(cases[n])), async (url, requests) => {
		const current = { ...model("openai-responses", url), adapter: { preset: "openai" as const, reasoningSummary: "auto" as const } };
		const first = await collect(current); assert.equal(first.message.stopReason, "stop", first.message.errorMessage);
		assert.equal(first.message.content[0].type === "thinking" && first.message.content[0].thinking, "one\n\ntwo");
		assert.equal(requests[0].body.reasoning.summary, "auto");
		const second = await collect(current); assert.equal(second.message.stopReason, "stop"); assert.ok(second.message.content[0].type === "thinking" && second.message.content[0].replay);
		assert.equal((await collect(current)).message.content[0].type, "text");
	});
});

test("Anthropic missing signature fails; required/manual continuation refuses missing replay; adaptive can omit foreign reasoning", async () => {
	await withHttp((res, n) => res.end(sse(n === 0 ? anthropic([{ ...aThink(), signature: "" }]) : n === 1 ? thoughtAndTools("anthropic-messages") : anthropic())), async (url, requests) => {
		const current = model("anthropic-messages", url);
		assert.equal((await collect(current)).message.stopReason, "error");
		const message = (await collect(current)).message;
		const context: Context = { messages: [user, message, { role: "toolResult", toolCallId: "call_1", toolName: "echo", content: [], isError: false, timestamp: 3 }, { role: "toolResult", toolCallId: "call_2", toolName: "echo", content: [], isError: false, timestamp: 3 }] };
		const prefs: StreamOptions = { thinking: { enabled: true, effort: "medium" } };
		assert.equal((await collect({ ...current, endpoint: `${url}/other` }, prefs, context)).message.stopReason, "error");
		assert.equal(requests.length, 2);
		assert.equal((await collect({ ...current, id: "claude-opus-4-6" }, prefs, context)).message.stopReason, "stop");
		assert.doesNotMatch(JSON.stringify(requests.at(-1)!.body), /signature|redacted_thinking/);
	});
});

test("Responses stream rejects inconsistent item identity, JSON arrays, duplicate calls, failed and content-filter terminal", async () => {
	const mismatch = responses([rTool()]); mismatch.find(e => e.type === "response.output_item.done")!.item = { ...rTool(), call_id: "other" };
	const duplicate = responses([rTool(), { ...rTool(), id: "fc_other" }]);
	const cases = [mismatch, responses([rTool("call_1", "[]")]), duplicate, [{ type: "response.failed", response: { error: { message: "failure" } } }], responses([rText()], "content_filter")];
	await withHttp((res, n) => res.end(sse(cases[n])), async url => { for (const _ of cases) assert.equal((await collect(model("openai-responses", url))).message.stopReason, "error"); });
});

test("Anthropic stream rejects invalid block order, invalid tool JSON, unknown stop, mismatched tools and invalid usage", async () => {
	const order = anthropic(); order[1].index = 2;
	const usage = anthropic(); usage[0].message.usage.input_tokens = -1;
	const cases = [order, anthropic([aTool("call_1", [])]), anthropic([], "pause_turn"), anthropic([aTool()], "end_turn"), usage];
	await withHttp((res, n) => res.end(sse(cases[n])), async url => { for (const _ of cases) assert.equal((await collect(model("anthropic-messages", url))).message.stopReason, "error"); });
});

for (const api of protocols) {
	test(`${api}: pre-abort, impossible disable and unknown explicit control never send HTTP`, async () => {
		await withHttp(res => res.end(sse(ok(api))), async (url, requests) => {
			const current = model(api, url);
			const aborted = AbortSignal.abort();
			assert.equal((await collect(current, { signal: aborted })).message.stopReason, "aborted");
			const unknown = { ...current, id: "unknown-model" };
			for (const enabled of [true, false]) assert.equal((await collect(unknown, { thinking: { enabled, effort: "max" } })).message.stopReason, "error");
			const thinking = api === "openai-responses" ? { mode: "effort" as const, levels: ["low"], canDisable: false } : { mode: "adaptive" as const, levels: ["high"], canDisable: false };
			assert.equal((await collect({ ...current, adapter: { thinking } }, { thinking: { enabled: false, effort: "max" } })).message.stopReason, "error");
			assert.equal(requests.length, 0);
			assert.equal((await collect(unknown)).message.stopReason, "stop");
			assert.equal(requests.length, 1);
		});
	});
	test(`${api}: old or partially sourced thinking cannot be replayed; required policy fails locally`, async () => {
		await withHttp((res, n) => res.end(sse(n === 0 ? thoughtAndTools(api) : ok(api))), async (url, requests) => {
			const current = model(api, url);
			const message = (await collect(current)).message;
			message.content.unshift({ type: "thinking", thinking: "legacy text" });
			const context: Context = { messages: [user, message, user] };
			await collect(current, {}, context);
			assert.doesNotMatch(JSON.stringify(requests[1].body), /opaque|signature|redacted_thinking|legacy text/);
			const count = requests.length;
			assert.equal((await collect({ ...current, adapter: { ...current.adapter, reasoningReplay: "required" } }, {}, context)).message.stopReason, "error");
			assert.equal(requests.length, count);
		});
	});
}

test("Anthropic explicitly enabled interleaving adds only the native beta header; off clears effort and beta", async () => {
	await withHttp(res => res.end(sse(anthropic())), async (url, requests) => {
		const current = { ...model("anthropic-messages", url), id: "claude-opus-4-6", adapter: { preset: "anthropic" as const, interleavedThinking: true } };
		await collect(current, { thinking: { enabled: true, effort: "high" } });
		assert.equal(requests[0].headers["anthropic-beta"], "interleaved-thinking-2025-05-14");
		await collect(current, { thinking: { enabled: false, effort: "high" } });
		assert.equal(requests[1].headers["anthropic-beta"], undefined);
		assert.equal(requests[1].body.output_config, undefined);
		assert.deepEqual(requests[1].body.thinking, { type: "disabled" });
		const context: Context = { messages: [
			{ role: "user", content: [{ type: "text", text: "" }, { type: "text", text: "read empty file" }], timestamp: 1 },
			{ role: "assistant", model: current.id, stopReason: "toolUse", content: [{ type: "toolCall", id: "call_1", name: "echo", arguments: {} }], timestamp: 2 },
			{ role: "toolResult", toolCallId: "call_1", toolName: "echo", content: [{ type: "text", text: "" }], isError: false, timestamp: 3 },
		] };
		assert.equal((await collect(current, {}, context)).message.stopReason, "stop");
		assert.deepEqual(requests[2].body.messages[0].content, [{ type: "text", text: "read empty file" }]);
		assert.deepEqual(requests[2].body.messages[2].content[0].content, [{ type: "text", text: "(no tool output)" }]);
	});
});

test("Responses refuses contradictions between streamed and terminal items, retains refusal text", async () => {
	const conflict = responses([rTool()]); conflict.at(-1)!.response.output = [{ ...rTool(), arguments: '{"n":1} ' }];
	const status = responses([rTool()]); status.at(-1)!.response.output = [{ ...rTool(), status: "in_progress" }];
	const refusal = { ...rText(), content: [{ type: "refusal", refusal: "cannot help" }] };
	const cases = [conflict, status, [{ type: "response.completed", response: { status: "completed", output: [refusal] } }]];
	await withHttp((res, n) => res.end(sse(cases[n])), async url => {
		assert.equal((await collect(model("openai-responses", url))).message.stopReason, "error");
		assert.equal((await collect(model("openai-responses", url))).message.stopReason, "error");
		const last = (await collect(model("openai-responses", url))).message;
		assert.equal(last.stopReason, "stop"); assert.deepEqual(last.content, [{ type: "text", text: "cannot help" }]);
	});
});
