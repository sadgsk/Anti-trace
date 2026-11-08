import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { Agent } from "../../src/agent/agent.ts";
import { Harness } from "../../src/harness/harness.ts";
import { summarizeConversation } from "../../src/harness/compaction.ts";
import { loadByokConfig } from "../../src/config/byok.ts";
import { CONNECTION_PRESETS } from "../../src/config/presets.ts";
import { streamModel, validateModelThinking } from "../../src/llm/adapter.ts";
import { resolveNativeRules, validateAdapterForApi, type NativeRules } from "../../src/llm/rules.ts";
import { appendEntry, createSessionFile, loadSession } from "../../src/harness/session.ts";
import type { Context, Model, ModelApi, StreamOptions, ThinkingLevel } from "../../src/types.ts";

type Obj = Record<string, any>;
type Request = { body: Obj; headers: Obj; path: string };
type Format = NonNullable<NativeRules["responsesReasoning"]>;
const user: Context["messages"][number] = { role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1 };
const levels: ThinkingLevel[] = ["low", "medium", "high", "xhigh", "max"];
const sse = (events: Obj[]) => events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
function model(preset: string, id: string, api: ModelApi, baseUrl: string): Model {
	return { id, name: id, provider: preset, api, baseUrl, adapter: { preset: preset as any }, contextWindow: 128000, maxOutputTokens: 32000 };
}
function reason(format: Format): Obj {
	const base = { type: "reasoning", id: "rs_1", status: "completed" };
	if (format === "content-object") return { ...base, content: { type: "reasoning_text", text: "考虑一下" } };
	if (format === "content" || format === "content-to-summary") return { ...base, summary: [], content: [{ type: "reasoning_text", text: "考虑一下" }] };
	return { ...base, summary: [{ type: "summary_text", text: "考虑一下" }], encrypted_content: format === "encrypted" ? "opaque+/==" : null };
}
function responseEvents(format: Format, tool = true): Obj[] {
	const thought = reason(format);
	const next = tool ? { type: "function_call", id: "fc_1", call_id: "call_1", name: "echo", arguments: '{"n":1}', status: "completed" }
		: { type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text: "done", annotations: [] }] };
	const textEvent = ["content", "content-object", "content-to-summary"].includes(format) ? "response.reasoning_text" : "response.reasoning_summary_text";
	const events: Obj[] = [
		{ type: "response.output_item.added", output_index: 0, item: { type: "reasoning", id: "rs_1", summary: [] } },
		{ type: `${textEvent}.delta`, output_index: 0, item_id: "rs_1", summary_index: 0, delta: "考虑" },
		{ type: `${textEvent}.delta`, output_index: 0, item_id: "rs_1", summary_index: 0, delta: "一下" },
		{ type: `${textEvent}.done`, output_index: 0, item_id: "rs_1", summary_index: 0, text: "考虑一下" },
		{ type: "response.output_item.done", output_index: 0, item: thought },
		{ type: "response.output_item.added", output_index: 1, item: { ...next, ...(tool ? { arguments: "" } : { content: [] }) } },
		{ type: "response.output_item.done", output_index: 1, item: next },
		{ type: "response.completed", response: { status: "completed", output: [thought, next], usage: { input_tokens: 12, output_tokens: 8 } } },
	];
	return events;
}
function messageEvents(signed: boolean, tool = true): Obj[] {
	const blocks: Obj[] = [{ type: "thinking", thinking: "考虑一下", ...(signed ? { signature: "sig+/==" } : {}) },
		tool ? { type: "tool_use", id: "call_1", name: "echo", input: { n: 1 } } : { type: "text", text: "done" }];
	return [
		{ type: "message_start", message: { role: "assistant", content: [], usage: { input_tokens: 8, output_tokens: 0, cache_read_input_tokens: 4 } } },
		...blocks.flatMap((block, index) => [{ type: "content_block_start", index, content_block: block }, { type: "content_block_stop", index }]),
		{ type: "message_delta", delta: { stop_reason: tool ? "tool_use" : "end_turn" }, usage: { output_tokens: 8 } }, { type: "message_stop" },
	];
}
async function http(respond: (res: ServerResponse, count: number, req: Request) => void, run: (url: string, requests: Request[]) => Promise<void>) {
	const requests: Request[] = [];
	const server = createServer(async (req, res) => {
		const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
		const request = { body: JSON.parse(Buffer.concat(chunks).toString()), headers: req.headers, path: req.url! };
		requests.push(request); respond(res, requests.length - 1, request);
	});
	await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
	try { const address = server.address(); assert.ok(address && typeof address !== "string"); await run(`http://127.0.0.1:${address.port}/v1`, requests); }
	finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}
async function collect(m: Model, options: StreamOptions = {}, context: Context = { messages: [user] }) {
	const stream = await streamModel(m, context, { apiKey: "fake-key", ...options });
	const events: Obj[] = []; for await (const event of stream) events.push(structuredClone(event));
	return { message: await stream.result(), events };
}
const cases: Array<[string, string, ModelApi, string[], boolean]> = [
	["deepseek", "deepseek-flash", "openai-responses", ["low", "high", "max", "max", "max"], true],
	["kimi", "kimi-k3", "openai-responses", ["low", "high", "max", "max", "max"], false],
	["glm", "glm-5.3", "openai-responses", ["high", "max", "max", "max", "max"], true],
	["qwen", "qwen3.8-max", "openai-responses", ["low", "medium", "xhigh", "xhigh", "xhigh"], true],
	["grok", "grok-4.7", "openai-responses", ["low", "medium", "high", "xhigh", "xhigh"], false],
	["minimax", "MiniMax-M3.1-Flash", "openai-responses", levels, false],
	["deepseek", "deepseek-flash", "anthropic-messages", ["low", "high", "max", "max", "max"], true],
	["kimi", "kimi-k3", "anthropic-messages", ["low", "high", "max", "max", "max"], false],
	["glm", "glm-5.3", "anthropic-messages", [], false],
	["qwen", "qwen3.8-max", "anthropic-messages", ["low", "medium", "xhigh", "xhigh", "xhigh"], true],
	["minimax", "MiniMax-M3.1-Flash", "anthropic-messages", levels, false],
];
for (const [preset, id, api, expected, canDisable] of cases) {
	const sample = model(preset, id, api, "https://unused.invalid/v1");
	const rules = { responsesReasoning: ({ deepseek: "content", kimi: "summary", glm: "content-object", qwen: "summary", grok: "encrypted", minimax: "content-to-summary" } as const)[preset],
		thinkingSignature: preset === "minimax" ? "required" : "optional", authHeader: ["kimi", "glm", "minimax"].includes(preset) ? "bearer" : "api-key" };
	const events = (tool: boolean) => api === "openai-responses" ? responseEvents(rules.responsesReasoning ?? "summary", tool).map(event => preset === "qwen" ? { ...event, type: event.type.replace("reasoning_summary_text", "reasoning_text") } : event) : messageEvents(rules.thinkingSignature === "required", tool);
	test(`${preset}/${api}: five levels, real off/default and auth reach HTTP`, async () => {
		await http(res => res.end(sse(events(false))), async (url, requests) => {
			const m = { ...sample, baseUrl: url };
			for (const effort of levels) assert.equal((await collect(m, { thinking: { enabled: true, effort } })).message.stopReason, "stop");
			assert.deepEqual(requests.slice(0, 5).map(r => api === "openai-responses" ? r.body.reasoning?.effort : r.body.output_config?.effort), expected.length ? expected : Array(5).fill(undefined));
			const off = await collect(m, { thinking: { enabled: false, effort: "max" } });
			assert.equal(off.message.stopReason, canDisable ? "stop" : "error");
			assert.equal(requests.length, canDisable ? 6 : 5);
			if (canDisable) assert.deepEqual(api === "openai-responses" ? requests[5].body.reasoning : requests[5].body.thinking, api === "openai-responses" ? { effort: "none" } : { type: "disabled" });
			await collect(m, { thinking: { effort: "max" } });
			assert.equal(requests.at(-1)!.body.reasoning, undefined); assert.equal(requests.at(-1)!.body.output_config, undefined); assert.equal(requests.at(-1)!.body.thinking, undefined);
			const keyHeader = api === "openai-responses" || rules.authHeader === "bearer" ? "authorization" : "x-api-key";
			assert.equal(requests[0].headers[keyHeader], keyHeader === "authorization" ? "Bearer fake-key" : "fake-key");
			if (api === "openai-responses") assert.equal(requests[0].body.include?.[0], rules.responsesReasoning === "encrypted" ? "reasoning.encrypted_content" : undefined);
		});
	});
	test(`${preset}/${api}: Agent tool continuation rotates credentials and replays complete native thinking`, async () => {
		await http((res, n) => { for (const byte of Buffer.from(sse(events(n === 0)))) res.write(Buffer.from([byte])); res.end(); }, async (url, requests) => {
			let key = 0; const executed: number[] = [];
			const agent = new Agent({ streamFn: streamModel, getApiKey: () => `key-${++key}`, initialState: { model: { ...sample, baseUrl: url }, thinking: { enabled: true, effort: "high" }, tools: [{ name: "echo", label: "Echo", description: "Echo", parameters: Type.Object({ n: Type.Number() }), async execute(_id, args) { assert.ok(args && typeof args === "object" && "n" in args); executed.push(Number(args.n)); return { content: [{ type: "text", text: "result" }], details: {} }; } }] } });
			await agent.prompt("call echo");
			assert.deepEqual(executed, [1]); assert.equal(requests.length, 2); assert.equal((agent.state.messages.at(-1) as any).stopReason, "stop");
			const wire = api === "openai-responses" ? requests[1].body.input.find((i: Obj) => i.type === "reasoning") : requests[1].body.messages[1].content.find((b: Obj) => b.type === "thinking");
			assert.ok(wire);
			if (preset === "minimax" && api === "openai-responses") assert.deepEqual(wire, { type: "reasoning", summary: [{ type: "summary_text", text: "考虑一下" }] });
			assert.match(JSON.stringify(wire), rules.responsesReasoning === "encrypted" && api === "openai-responses" ? /opaque/ : /考虑一下/);
			if (api === "anthropic-messages" && rules.thinkingSignature === "optional") assert.equal(Object.hasOwn(wire, "signature"), false);
			assert.equal(agent.state.messages.filter(m => m.role === "assistant")[0].content[0].type, "thinking");
			assert.equal(key, 2);
		});
	});
}

test("native preset paths, credential isolation and example configuration", () => {
	const root = resolve(mkdtempSync(join(tmpdir(), "native-compat-config-")));
	try {
		for (const [preset, connection] of Object.entries(CONNECTION_PRESETS).filter(([key]) => key.endsWith("-responses") || key.endsWith("-anthropic"))) {
			const path = join(root, "byok.json");
			writeFileSync(path, JSON.stringify({ version: 1, connections: { c: { preset, apiKey: "local-key" } }, models: { m: { connection: "c", id: "custom", contextWindow: 128000, maxOutputTokens: 32000 } }, currentModel: "m" }));
			const c = loadByokConfig({ configPath: path }); assert.equal(c.model.api, connection.api); assert.equal(c.model.baseUrl, connection.baseUrl); assert.equal(c.getApiKey(c.model), "local-key");
			assert.throws(() => c.getApiKey({ ...c.model, baseUrl: "https://foreign.invalid" }), /连接/);
		}
		const c = loadByokConfig({ configPath: fileURLToPath(new URL("../../byok.providers.example.json", import.meta.url)) });
		for (const m of Object.values(c.models)) validateModelThinking(m, { enabled: true, effort: "high" });
	} finally { assert.equal(dirname(root), resolve(tmpdir())); rmSync(root, { recursive: true, force: true }); }
});

test("protocol fields cannot leak into another API and unknown bindings stay explicit", () => {
	assert.throws(() => validateAdapterForApi({ responsesReasoning: "summary" }, "anthropic-messages"));
	assert.throws(() => validateAdapterForApi({ thinkingSignature: "optional" }, "openai-responses"));
	assert.throws(() => validateAdapterForApi({ preset: "grok" }, "anthropic-messages"));
	assert.throws(() => validateAdapterForApi({ preset: "gemini" }, "openai-responses"));
	assert.throws(() => validateModelThinking(model("kimi", "unknown", "openai-responses", "https://unused.invalid"), { enabled: true, effort: "high" }));
});

test("Qwen budget is separate from answer tokens; older Responses toggle and MiniMax adaptive toggle", async () => {
	await http(res => res.end(sse(messageEvents(false, false))), async (url, requests) => {
		const m = model("qwen", "qwen3.5-plus", "anthropic-messages", url);
		assert.equal((await collect(m, { thinking: { enabled: true, effort: "max" }, maxTokens: 256 })).message.stopReason, "stop");
		assert.equal(requests[0].body.max_tokens, 256); assert.equal(requests[0].body.thinking.budget_tokens, 16384);
	});
	await http(res => res.end(sse(responseEvents("summary", false))), async (url, requests) => {
		const m = model("qwen", "qwen3.5-plus", "openai-responses", url);
		for (const enabled of [true, false]) assert.equal((await collect(m, { thinking: { enabled, effort: "high" } })).message.stopReason, "stop");
		assert.deepEqual(requests.map(r => r.body.enable_thinking), [true, false]);
	});
	await http(res => res.end(sse(messageEvents(true, false))), async (url, requests) => {
		const m = model("minimax", "MiniMax-M3", "anthropic-messages", url);
		await collect(m, { thinking: { enabled: true, effort: "max" } }); await collect(m, { thinking: { enabled: false, effort: "max" } });
		assert.deepEqual(requests.map(r => r.body.thinking), [{ type: "adaptive" }, { type: "disabled" }]); assert.equal(requests[0].body.output_config, undefined);
	});
});

test("Qwen reasoning_text streams immediately into summary and contradictory final reasoning fails", async () => {
	const events: Obj[] = responseEvents("summary", false).map(event => ({ ...event, type: event.type.replace("reasoning_summary_text", "reasoning_text") }));
	await http(res => res.end(sse(events)), async url => {
		const result = await collect(model("qwen", "qwen3.8-max", "openai-responses", url));
		assert.equal(result.message.stopReason, "stop");
		assert.deepEqual(result.events.filter(e => e.type === "thinking_delta").map(e => e.delta), ["考虑", "一下"]);
	});
	const contradictory = structuredClone(events); contradictory.at(-1)!.response.output[0].summary[0].text = "different";
	await http(res => res.end(sse(contradictory)), async url => {
		const result = await collect(model("qwen", "qwen3.8-max", "openai-responses", url));
		assert.equal(result.message.stopReason, "error");
		assert.ok(!result.message.content.some(b => b.type === "thinking" && b.replay));
	});
});

for (const api of ["openai-responses", "anthropic-messages"] as const) {
	test(`${api}: real summary retries preserve settings, refresh keys and keep live history unchanged`, async () => {
		await http((res, n) => res.end(sse(api === "openai-responses" ? responseEvents("content", n === 0) : messageEvents(false, n === 0))), async (url, requests) => {
			const m = api === "openai-responses" ? model("deepseek", "deepseek-flash", api, url) : model("qwen", "qwen3.5-plus", api, url);
			const context: Context = { messages: [structuredClone(user)] }; const before = structuredClone(context); let keys = 0;
			const summary = await summarizeConversation({ streamFn: streamModel, model: m, context, getApiKey: () => `summary-${++keys}`, thinking: { enabled: true, effort: "max" }, reserveTokens: 1000 });
			assert.equal(summary, "done"); assert.equal(keys, 2); assert.deepEqual(context, before);
			assert.deepEqual(requests.map(r => r.headers[api === "openai-responses" ? "authorization" : "x-api-key"]), api === "openai-responses" ? ["Bearer summary-1", "Bearer summary-2"] : ["summary-1", "summary-2"]);
			for (const r of requests) {
				assert.equal(r.body[api === "openai-responses" ? "max_output_tokens" : "max_tokens"], 800);
				if (api === "openai-responses") assert.deepEqual(r.body.reasoning, { effort: "max" });
				else assert.deepEqual(r.body.thinking, { type: "enabled", budget_tokens: 16384 });
			}
		});
	});
}

test("multi-part plaintext reasoning survives content-part events and preserves replay order", async () => {
	const item = { type: "reasoning", id: "rs_1", status: "completed", content: [{ type: "reasoning_text", text: "one" }, { type: "reasoning_text", text: "two" }] };
	const events: Obj[] = [{ type: "response.output_item.added", output_index: 0, item: { type: "reasoning", id: "rs_1", content: [] } }];
	item.content.forEach((part, content_index) => events.push(
		{ type: "response.content_part.added", output_index: 0, content_index, part: { ...part, text: "" } },
		{ type: "response.reasoning_text.delta", output_index: 0, content_index, delta: part.text },
		{ type: "response.content_part.done", output_index: 0, content_index, part },
	));
	events.push({ type: "response.output_item.done", output_index: 0, item }, { type: "response.completed", response: { status: "completed", output: [item] } });
	await http(res => res.end(sse(events)), async (url, requests) => {
		const m = model("deepseek", "deepseek-flash", "openai-responses", url);
		const first = await collect(m); assert.equal(first.message.stopReason, "stop");
		assert.equal(first.message.content[0].type === "thinking" && first.message.content[0].thinking, "one\n\ntwo");
		await collect(m, {}, { messages: [user, first.message] });
		assert.deepEqual(requests[1].body.input[1], { type: "reasoning", id: "rs_1", content: item.content });
	});
});

for (const format of ["summary", "content", "content-object"] as const) {
	const preset = format === "summary" ? "kimi" : format === "content" ? "deepseek" : "glm";
	const id = preset === "kimi" ? "kimi-k3" : preset === "deepseek" ? "deepseek-flash" : "glm-5.3";
	test(`${format}: JSONL replay round trip, source isolation and malformed final snapshots`, async () => {
		const root = resolve(mkdtempSync(join(tmpdir(), "native-compat-replay-")));
		try {
			await http(res => res.end(sse(responseEvents(format))), async (url, requests) => {
				const m = model(preset, id, "openai-responses", url);
				const first = (await collect(m)).message; assert.equal(first.stopReason, "toolUse");
				const session = createSessionFile(root, root); appendEntry(session, { type: "message", message: user }); appendEntry(session, { type: "message", message: first });
				const messages = loadSession(session.path).messages;
				await collect(m, {}, { messages }); assert.ok(requests[1].body.input.some((i: Obj) => i.type === "reasoning"));
				await collect({ ...m, id: "other" }, {}, { messages }); assert.ok(!requests[2].body.input.some((i: Obj) => i.type === "reasoning"));
				await collect({ ...m, provider: "other" }, {}, { messages }); assert.ok(!requests[3].body.input.some((i: Obj) => i.type === "reasoning"));
				await collect({ ...m, endpoint: url + "/other" }, {}, { messages }); assert.ok(!requests[4].body.input.some((i: Obj) => i.type === "reasoning"));
				assert.deepEqual(messages[1], first);
			});
			const events = responseEvents(format); const item = events.at(-1)!.response.output[0];
			if (format === "summary") item.summary[0].text = "conflict"; else if (format === "content") item.content[0].text = "conflict"; else item.content.text = "conflict";
			await http(res => res.end(sse(events)), async url => { const r = await collect(model(preset, id, "openai-responses", url)); assert.equal(r.message.stopReason, "error"); assert.ok(!r.message.content.some(b => b.type === "toolCall" || b.type === "thinking" && b.replay)); });
		} finally { assert.equal(dirname(root), resolve(tmpdir())); rmSync(root, { recursive: true, force: true }); }
	});
	test(`${format}: incomplete, trailing error and abort never commit replay or tools`, async () => {
		for (const ending of ["truncated", "error", "abort"]) {
			let events = responseEvents(format);
			if (ending === "truncated") events[events.length - 1] = { type: "response.incomplete", response: { ...events.at(-1)!.response, status: "incomplete", incomplete_details: { reason: "max_output_tokens" } } };
			if (ending === "error") events.push({ type: "error", message: "fake-key failure" });
			await http(res => ending === "abort" ? res.write(sse(events.slice(0, 2))) : res.end(sse(events)), async url => {
				const controller = new AbortController(); const stream = await streamModel(model(preset, id, "openai-responses", url), { messages: [user] }, { apiKey: "fake-key", signal: controller.signal });
				for await (const event of stream) if (ending === "abort" && event.type === "thinking_delta") controller.abort();
				const m = await stream.result(); assert.equal(m.stopReason, ending === "truncated" ? "length" : ending === "abort" ? "aborted" : "error");
				assert.ok(!m.content.some(b => b.type === "toolCall" || b.type === "thinking" && b.replay)); assert.doesNotMatch(m.errorMessage ?? "", /fake-key/);
			});
		}
	});
}

test("optional signatures do not weaken native Anthropic checks or bypass source isolation", async () => {
	await http(res => res.end(sse(messageEvents(false))), async (url, requests) => {
		const m = model("deepseek", "deepseek-flash", "anthropic-messages", url);
		const first = (await collect(m)).message; assert.equal(first.stopReason, "toolUse");
		const native = await collect(model("anthropic", "claude-sonnet-4-6", "anthropic-messages", url)); assert.equal(native.message.stopReason, "error");
		await collect({ ...m, provider: "other" }, {}, { messages: [user, first] });
		assert.ok(!requests[2].body.messages[1].content.some((b: Obj) => b.type === "thinking"));
	});
});

for (const api of ["openai-responses", "anthropic-messages"] as const) {
	test(`${api}: text-only tool results preserve image groups after the complete tool batch`, async () => {
		await http(res => res.end(sse(api === "openai-responses" ? responseEvents("content-object", false) : messageEvents(false, false))), async (url, requests) => {
			const m = model(api === "openai-responses" ? "glm" : "qwen", api === "openai-responses" ? "glm-5.3" : "qwen3.8-max", api, url);
			const context: Context = { messages: [user, { role: "assistant", model: m.id, timestamp: 2, stopReason: "toolUse", content: [1, 2].map(n => ({ type: "toolCall", id: `c${n}`, name: "read", arguments: {} })) },
				...[1, 2].map(n => ({ role: "toolResult" as const, toolName: "read", toolCallId: `c${n}`, timestamp: 3, isError: false, content: [{ type: "text" as const, text: `image-${n}` }, { type: "image" as const, data: `data-${n}`, mimeType: "image/png" }] }))] };
			assert.equal((await collect(m, {}, context)).message.stopReason, "stop");
			const payload = requests[0].body;
			if (api === "openai-responses") { assert.deepEqual(payload.input.slice(3, 5).map((i: Obj) => i.output), ["image-1", "image-2"]); assert.equal(payload.input[5].role, "user"); }
			else { const content = payload.messages[2].content; assert.deepEqual(content.slice(0, 2).map((b: Obj) => b.content), ["image-1", "image-2"]); assert.equal(content[2].type, "text"); }
			assert.match(JSON.stringify(payload), /data-1/); assert.match(JSON.stringify(payload), /data-2/);
		});
	});
	test(`${api}: Harness remains usable after HTTP failure and persists model settings`, async () => {
		const root = resolve(mkdtempSync(join(tmpdir(), "native-compat-harness-")));
		try { await http((res, n) => { if (n === 0) { res.statusCode = 401; res.end("denied"); } else res.end(sse(api === "openai-responses" ? responseEvents("content", false) : messageEvents(false, false))); }, async url => {
			const h = new Harness({ cwd: root, sessionsRoot: root, streamFn: streamModel });
			h.configureModel({ model: model("deepseek", "deepseek-flash", api, url), modelRef: { configPath: join(root, "config.json"), modelKey: "m" }, getApiKey: () => "fake-key" });
			await h.prompt("first"); assert.equal((h.agent.state.messages.at(-1) as any).stopReason, "error");
			h.setThinkingEnabled(true); await h.prompt("second"); assert.equal((h.agent.state.messages.at(-1) as any).stopReason, "stop");
			const saved = loadSession(h.listSessions()[0].filePath); assert.equal(saved.settings?.modelRef?.modelKey, "m"); assert.equal(saved.settings?.thinking.enabled, true);
		}); } finally { assert.equal(dirname(root), resolve(tmpdir())); rmSync(root, { recursive: true, force: true }); }
	});
}
