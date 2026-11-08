import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { Type } from "typebox";
import { Agent } from "../../src/agent/agent.ts";
import { runCli } from "../../src/cli/main.ts";
import { loadByokConfig } from "../../src/config/byok.ts";
import { streamModel } from "../../src/llm/adapter.ts";
import { readSse } from "../../src/llm/sse.ts";
import type { AdapterConfig, ThinkingRule } from "../../src/llm/rules.ts";
import type { AssistantMessage, AssistantMessageEvent, Context, Model, StreamOptions, ThinkingLevel } from "../../src/types.ts";

const levels: ThinkingLevel[] = ["low", "medium", "high", "xhigh", "max"];
const sse = (...chunks: unknown[]) => chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n";
const delta = (value: object, finish_reason: string | null = null) => ({ choices: [{ delta: value, finish_reason }] });
const ok = () => sse(delta({ content: "ok" }, "stop"));
type Request = { path: string; body: Record<string, any>; authorization: string | undefined };

async function withHttp(
	respond: (response: ServerResponse, index: number) => void,
	run: (url: string, requests: Request[]) => Promise<void>,
) {
	const requests: Request[] = [];
	const server = createServer(async (req, res) => {
		const parts: Buffer[] = [];
		for await (const chunk of req) parts.push(Buffer.from(chunk));
		requests.push({ path: req.url!, body: JSON.parse(Buffer.concat(parts).toString()), authorization: req.headers.authorization });
		res.writeHead(200, { "Content-Type": "text/event-stream" });
		respond(res, requests.length - 1);
	});
	await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
	try {
		const address = server.address();
		assert.ok(address && typeof address === "object");
		await run(`http://127.0.0.1:${address.port}/v1`, requests);
	} finally {
		server.closeAllConnections();
		await new Promise<void>(resolve => server.close(() => resolve()));
	}
}

function model(baseUrl: string, adapter?: AdapterConfig): Model {
	return { id: "custom", name: "Test", provider: "connection", api: "openai-completions", baseUrl, contextWindow: 128000, maxOutputTokens: 4096, ...(adapter ? { adapter } : {}) };
}
async function collect(current: Model, options?: StreamOptions, context: Context = { messages: [{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1 }] }) {
	const stream = await streamModel(current, context, { apiKey: "local-fake-key", ...options });
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) events.push(event);
	return { message: await stream.result(), events };
}
function tempRoot() {
	const root = resolve(mkdtempSync(join(tmpdir(), "cli-agent-chat-")));
	return { root, cleanup() {
		assert.equal(dirname(root), resolve(tmpdir()));
		assert.match(basename(root), /^cli-agent-chat-/);
		rmSync(root, { recursive: true, force: true });
	} };
}

test("five local efforts map in order, repeat the strongest native effort, and disable independently", async () => {
	await withHttp(res => res.end(ok()), async (url, requests) => {
		const current = model(url, { thinking: { mode: "effort", levels: ["minimal", "low", "medium", "high"], off: "none" }, maxTokensField: "max_completion_tokens" });
		for (const effort of levels) assert.equal((await collect(current, { thinking: { enabled: true, effort } })).message.stopReason, "stop");
		assert.deepEqual(requests.map(item => item.body.reasoning_effort), ["minimal", "low", "medium", "high", "high"]);
		const preference = Object.freeze({ enabled: false, effort: "max" as const });
		await collect(current, { thinking: preference, maxTokens: 1000 });
		assert.equal(requests[5].body.reasoning_effort, "none");
		assert.equal(requests[5].body.max_completion_tokens, 1000);
		assert.equal(requests[5].body.max_tokens, undefined);
		assert.deepEqual(preference, { enabled: false, effort: "max" });
		await collect(current, { thinking: { effort: "max" } });
		assert.equal(requests[6].body.reasoning_effort, undefined);
	});
});

test("both toggle dialects use one on result for all five levels and a real off encoding", async () => {
	await withHttp(res => res.end(ok()), async (url, requests) => {
		for (const format of ["thinking-type", "enable-thinking"] as const) {
			const current = model(url, { thinking: { mode: "toggle", format } });
			const start = requests.length;
			for (const effort of levels) await collect(current, { thinking: { enabled: true, effort } });
			await collect(current, { thinking: { enabled: false, effort: "max" } });
			for (const item of requests.slice(start, start + 5)) {
				assert.equal(item.body.reasoning_effort, undefined);
				if (format === "thinking-type") assert.deepEqual(item.body.thinking, { type: "enabled" });
				else assert.equal(item.body.enable_thinking, true);
			}
			if (format === "thinking-type") assert.deepEqual(requests.at(-1)!.body.thinking, { type: "disabled" });
			else assert.equal(requests.at(-1)!.body.enable_thinking, false);
		}
	});
});

test("budget mode looks up five values directly, reserves answer space, and removes budget when off", async () => {
	await withHttp(res => res.end(ok()), async (url, requests) => {
		for (const format of ["thinking-type", "enable-thinking"] as const) {
			const current = model(url, { thinking: { mode: "budget", format, budgets: { low: 128, medium: 256, high: 512, xhigh: 1024, max: 2048 }, minBudget: 128, maxBudget: 2048, answerReserveTokens: 512 } });
			const start = requests.length;
			for (const effort of levels) await collect(current, { thinking: { enabled: true, effort } });
			assert.deepEqual(requests.slice(start).map(item => item.body.thinking_budget ?? item.body.thinking?.budget_tokens), [128, 256, 512, 1024, 2048]);
			await collect(current, { thinking: { enabled: true, effort: "max" }, maxTokens: 1100 });
			assert.equal(requests.at(-1)!.body.thinking_budget ?? requests.at(-1)!.body.thinking.budget_tokens, 588);
			assert.equal(requests.at(-1)!.body.reasoning_effort, undefined);
			await collect(current, { thinking: { enabled: false, effort: "max" } });
			assert.equal(requests.at(-1)!.body.thinking_budget, undefined);
			assert.equal(requests.at(-1)!.body.thinking?.budget_tokens, undefined);
			const before = requests.length;
			const result = await collect(current, { thinking: { enabled: true, effort: "low" }, maxTokens: 600 });
			assert.equal(result.message.stopReason, "error");
			assert.match(result.message.errorMessage!, /最低思考预算/);
			assert.equal(requests.length, before);
		}
	});
});

test("unknown interfaces and impossible off requests fail before HTTP, without inferring from provider/model names", async () => {
	await withHttp(res => res.end(ok()), async (url, requests) => {
		const current = { ...model(url), id: "gpt-5.1", provider: "openai" };
		for (const enabled of [true, false]) assert.equal((await collect(current, { thinking: { enabled, effort: "max" } })).message.stopReason, "error");
		assert.equal(requests.length, 0);
		await collect(current);
		assert.equal(requests[0].body.reasoning_effort, undefined);
		assert.equal(requests[0].body.max_tokens, 4096);
		const explicit = { ...current, adapter: { preset: "openai" as const } };
		await collect(explicit, { thinking: { enabled: true, effort: "medium" } }, { systemPrompt: "rules", messages: [] });
		assert.equal(requests[1].body.reasoning_effort, "medium");
		assert.equal(requests[1].body.max_completion_tokens, 4096);
		assert.equal(requests[1].body.messages[0].role, "developer");
		const before = requests.length;
		for (const thinking of [
			{ mode: "effort", levels: ["low", "high"] },
			{ mode: "toggle", format: "thinking-type", canDisable: false },
		] satisfies ThinkingRule[]) {
			assert.equal((await collect(model(url, { thinking }), { thinking: { enabled: false, effort: "low" } })).message.stopReason, "error");
		}
		assert.equal(requests.length, before);
		for (const api of ["openai-responses", "anthropic-messages"] as const) {
			const result = await collect({ ...current, api }, { thinking: { enabled: true, effort: "max" } });
			assert.match(result.message.errorMessage!, /没有思考控制规则/);
		}
		assert.equal(requests.length, before);
	});
});

test("model overrides replace a complete thinking rule while inheriting connection compatibility", () => {
	const temp = tempRoot();
	try {
		const config = { version: 1, connections: { shared: { api: "openai-completions", baseUrl: "https://example.invalid/v1", apiKey: "fake-key", adapter: { thinking: { mode: "effort", levels: ["low", "high"], off: "none" }, maxTokensField: "max_completion_tokens", includeUsage: false } } }, models: {
			a: { connection: "shared", id: "a", contextWindow: 8192 },
			b: { connection: "shared", id: "b", contextWindow: 8192, adapter: { thinking: { mode: "toggle", format: "enable-thinking" }, reasoningReplay: "same-source" } },
		}, currentModel: "b" };
		const path = join(temp.root, "byok.json");
		writeFileSync(path, JSON.stringify(config));
		const loaded = loadByokConfig({ cwd: temp.root, env: {} });
		assert.deepEqual(loaded.model.adapter, { thinking: { mode: "toggle", format: "enable-thinking" }, maxTokensField: "max_completion_tokens", includeUsage: false, reasoningReplay: "same-source" });
		const selectedModel: Model = loaded.model;
		selectedModel.adapter!.thinking = { mode: "unsupported" };
		assert.equal(loaded.models.b.adapter!.thinking!.mode, "toggle");
		assert.equal(loaded.models.a.adapter!.thinking!.mode, "effort");
		assert.doesNotMatch(JSON.stringify(loaded.models), /fake-key/);
		for (const thinking of [
			{ mode: "effort", levels: ["low", "low"] },
			{ mode: "effort", levels: ["none", "high"] },
			{ mode: "effort", levels: ["low", "high"], off: "low" },
			{ mode: "effort", levels: ["low"], off: "none", toggle: "thinking-type" },
			{ mode: "budget", format: "enable-thinking", budgets: { low: 128, medium: 256, high: 512, xhigh: 512, max: 2048 }, minBudget: 128, answerReserveTokens: 512 },
		]) {
			writeFileSync(path, JSON.stringify({ ...config, models: { ...config.models, b: { ...config.models.b, adapter: { thinking } } } }));
			assert.throws(() => loadByokConfig({ cwd: temp.root, env: {} }));
		}
	} finally { temp.cleanup(); }
});

test("Agent completes a real HTTP tool round-trip with thinking events, replay and trailing usage", async () => {
	await withHttp((res, index) => res.end(index === 0 ? sse(
		delta({ reasoning_content: "先检查" }), delta({ reasoning_content: "一下" }),
		delta({ tool_calls: [{ index: 0, id: "call1", function: { name: "noop", arguments: '{"value":' } }] }),
		delta({ tool_calls: [{ index: 0, function: { arguments: '1}' } }] }, "tool_calls"),
	) : sse(delta({ reasoning_content: "已确认" }), delta({ content: "完成" }, "stop"), { choices: [], usage: { prompt_tokens: 90, completion_tokens: 12, total_tokens: 102 } })), async (url, requests) => {
		let executions = 0;
		const events: string[] = [];
		const agent = new Agent({ streamFn: streamModel, apiKey: "local-fake-key", initialState: {
			model: model(url, { thinking: { mode: "toggle", format: "thinking-type" }, reasoningReplay: "required" }),
			thinking: { enabled: true, effort: "max" }, tools: [{ name: "noop", label: "noop", description: "test", parameters: Type.Object({ value: Type.Number() }),
				async execute(_id, args) { executions++; assert.ok(args && typeof args === "object" && "value" in args); assert.equal(args.value, 1); return { content: [{ type: "text", text: "tool result" }], details: {} }; } }],
		} });
		agent.subscribe(event => { if (event.type === "message_update") events.push(event.assistantMessageEvent.type); });
		await agent.prompt("use tool");
		assert.equal(executions, 1);
		assert.equal(requests.length, 2);
		assert.ok(events.includes("thinking_start") && events.includes("thinking_delta") && events.includes("thinking_end"));
		assert.deepEqual(requests.map(item => item.body.thinking), [{ type: "enabled" }, { type: "enabled" }]);
		const wire = requests[1].body.messages;
		assert.equal(wire[1].reasoning_content, "先检查一下");
		assert.equal(wire[1].tool_calls[0].id, "call1");
		assert.deepEqual(wire[2], { role: "tool", tool_call_id: "call1", content: "tool result" });
		const final = agent.state.messages.at(-1) as AssistantMessage;
		assert.deepEqual(final.usage, { input: 90, output: 12, totalTokens: 102 });
		assert.equal(final.stopReason, "stop");
		assert.equal(final.content[0].type, "thinking");
	});
});

test("reasoning uses its configured field, retains interleaved blocks and only replays matching sources", async () => {
	await withHttp(res => res.end(sse(delta({ reasoning: "一" }), delta({ content: "正文" }), delta({ reasoning: "二" }), delta({ content: "结束" }, "stop"))), async (url, requests) => {
		const current = model(url, { reasoningField: "reasoning", reasoningReplay: "same-source", includeUsage: false });
		const first = (await collect(current)).message;
		assert.deepEqual(first.content.map(block => block.type), ["thinking", "text", "thinking", "text"]);
		const original = structuredClone(first);
		await collect(current, undefined, { messages: [first] });
		assert.equal(requests.at(-1)!.body.messages[0].reasoning, "一二");
		assert.equal(requests.at(-1)!.body.stream_options, undefined);
		for (const change of [{ provider: "other" }, { id: "other" }, { endpoint: `${url}/other` }, { baseUrl: `${url}/other` }]) {
			await collect({ ...current, ...change }, undefined, { messages: [first] });
			assert.equal(requests.at(-1)!.body.messages[0].reasoning, undefined);
			assert.equal(requests.at(-1)!.body.messages[0].content, "正文结束");
		}
		await collect({ ...current, adapter: { ...current.adapter, reasoningField: "reasoning_content" } }, undefined, { messages: [first] });
		assert.equal(requests.at(-1)!.body.messages[0].reasoning_content, undefined);
		assert.deepEqual(first, original);
	});
});

test("required replay rejects foreign or legacy tool reasoning before making a request", async () => {
	await withHttp(res => res.end(ok()), async (url, requests) => {
		const current = model(url, { reasoningReplay: "required" });
		const assistant: AssistantMessage = { role: "assistant", model: current.id, timestamp: 1, stopReason: "toolUse", content: [
			{ type: "thinking", thinking: "legacy display only" }, { type: "toolCall", id: "c1", name: "noop", arguments: {} },
		] };
		const result = await collect(current, undefined, { messages: [assistant, { role: "toolResult", toolCallId: "c1", toolName: "noop", content: [], isError: false, timestamp: 2 }] });
		assert.equal(result.message.stopReason, "error");
		assert.match(result.message.errorMessage!, /缺少.*完整思考/);
		assert.equal(requests.length, 0);
	});
});

test("an explicitly empty reasoning field is replayable, but a partially sourced history is not", async () => {
	await withHttp(res => res.end(sse(delta({ reasoning_content: "", tool_calls: [{ index: 0, id: "c1", function: { name: "noop", arguments: "{}" } }] }, "tool_calls"))), async (url, requests) => {
		const current = model(url, { reasoningReplay: "required" });
		const first = (await collect(current)).message;
		const context: Context = { messages: [first, { role: "toolResult", toolCallId: "c1", toolName: "noop", content: [], isError: false, timestamp: 1 }] };
		await collect(current, undefined, context);
		assert.equal(requests[1].body.messages[0].reasoning_content, "");
		first.content.push({ type: "thinking", thinking: "missing native metadata" });
		const result = await collect(current, undefined, context);
		assert.equal(result.message.stopReason, "error");
		assert.equal(requests.length, 2);
	});
});

test("SSE framing handles single-byte UTF-8 chunks, CRLF/CR, comments, multi-line data and EOF", async () => {
	const bytes = new TextEncoder().encode(': heartbeat\r\nevent: message\r\ndata: {"text":\r\ndata: "中文"}\r\n\r\ndata: tail\r\rdata: eof');
	const body = new ReadableStream<Uint8Array>({ start(controller) { for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); controller.close(); } });
	const events = [];
	for await (const event of readSse(body)) events.push(event);
	assert.deepEqual(events, [{ event: "message", data: '{"text":\n"中文"}' }, { event: undefined, data: "tail" }, { event: undefined, data: "eof" }]);
});

test("missing finish, invalid JSON and errors after partial output never succeed or create replay", async () => {
	const cases = [
		sse(delta({ reasoning_content: "partial" })),
		'data: {"choices":',
		sse(delta({ reasoning_content: "partial" }, "stop"), { error: { message: "late provider failure" } }),
		sse(delta({ content: "partial" }, "content_filter")),
	];
	await withHttp((res, index) => res.end(cases[index]), async (url) => {
		for (const _ of cases) {
			const result = await collect(model(url));
			assert.equal(result.message.stopReason, "error");
			assert.equal(result.events.at(-1)!.type, "error");
			assert.ok(!result.message.content.some(block => block.type === "thinking" && block.replay));
		}
	});
});

test("output truncation retains thinking text but cannot execute incomplete tools or replay reasoning", async () => {
	await withHttp(res => res.end(sse(delta({ reasoning_content: "partial" }), delta({ tool_calls: [{ index: 0, id: "c1", function: { name: "noop", arguments: '{"x":' } }] }, "length"))), async (url) => {
		let executions = 0;
		const agent = new Agent({ streamFn: streamModel, apiKey: "local-fake-key", initialState: { model: model(url), tools: [{ name: "noop", label: "noop", description: "noop", parameters: Type.Object({}), async execute() { executions++; return { content: [], details: {} }; } }] } });
		await agent.prompt("test");
		const final = agent.state.messages.at(-1) as AssistantMessage;
		assert.equal(final.stopReason, "length");
		assert.equal(executions, 0);
		assert.equal(final.content.some(block => block.type === "toolCall"), false);
		assert.equal(final.content[0].type, "thinking");
		assert.ok(!final.content.some(block => block.type === "thinking" && block.replay));
	});
});

test("abort after a thinking delta cancels the stream without making its partial data replayable", async () => {
	await withHttp(res => { res.write(`data: ${JSON.stringify(delta({ reasoning_content: "partial" }))}\n\n`); }, async (url) => {
		const controller = new AbortController();
		const stream = await streamModel(model(url), { messages: [] }, { apiKey: "local-fake-key", signal: controller.signal });
		for await (const event of stream) if (event.type === "thinking_delta") controller.abort();
		const result = await stream.result();
		assert.equal(result.stopReason, "aborted");
		assert.ok(!result.content.some(block => block.type === "thinking" && block.replay));
	});
});

test("parallel tool deltas preserve call identity and JSON, and invalid tool arguments fail", async () => {
	await withHttp((res, index) => res.end(index === 0 ? sse(
		delta({ tool_calls: [{ index: 1, id: "b", function: { name: "two", arguments: '{"n":' } }, { index: 0, id: "a", function: { name: "one", arguments: "{}" } }] }),
		delta({ tool_calls: [{ index: 1, function: { arguments: "2}" } }] }, "tool_calls"),
	) : sse(delta({ tool_calls: [{ index: 0, id: "c", function: { name: "noop", arguments: "[]" } }] }, "tool_calls"))), async (url) => {
		const first = await collect(model(url));
		assert.equal(first.message.stopReason, "toolUse");
		assert.deepEqual(first.message.content.filter(block => block.type === "toolCall").map(block => [block.id, block.name, block.arguments]), [["b", "two", { n: 2 }], ["a", "one", {}]]);
		const invalid = (await collect(model(url))).message;
		assert.equal(invalid.stopReason, "error");
		assert.equal(invalid.content.some(block => block.type === "toolCall"), false);
	});
});

test("CLI uses configured rules and persists complete replay without credentials", async () => {
	await withHttp(res => res.end(sse(delta({ reasoning_content: "完整思考" }), delta({ content: "visible" }, "stop"))), async (url, requests) => {
		const temp = tempRoot();
		try {
			writeFileSync(join(temp.root, "byok.json"), JSON.stringify({
				version: 1,
				connections: { local: { api: "openai-completions", baseUrl: url, endpoint: `${url}/exact`, apiKey: "local-fake-key" } },
				models: { main: { connection: "local", id: "custom", contextWindow: 8192, maxOutputTokens: 1024,
					adapter: { thinking: { mode: "effort", levels: ["low", "high"], off: "none" }, reasoningReplay: "same-source" } } },
				currentModel: "main", thinking: { enabled: true, effort: "max" },
			}));
			const stdin = new PassThrough();
			const stdout = new PassThrough();
			const stderr = new PassThrough();
			let output = "";
			stdout.on("data", chunk => { output += chunk.toString(); });
			stdin.end("hello");
			const sessionsRoot = join(temp.root, "sessions");
			assert.equal(await runCli({ cwd: temp.root, sessionsRoot, streams: { stdin, stdout, stderr } }), 0);
			assert.equal(output.includes("visible"), true);
			assert.equal(output.includes("[思考] 完整思考"), true);
			assert.equal(requests[0].path, "/v1/exact");
			assert.equal(requests[0].authorization, "Bearer local-fake-key");
			assert.equal(requests[0].body.reasoning_effort, "high");
			const bucket = join(sessionsRoot, readdirSync(sessionsRoot)[0]);
			const sessionPath = join(bucket, readdirSync(bucket).find(name => name.endsWith(".jsonl"))!);
			const text = readFileSync(sessionPath, "utf8");
			assert.doesNotMatch(text, /local-fake-key|Authorization/);
			assert.match(text, /完整思考/);
			const message = text.trim().split("\n").map(line => JSON.parse(line)).find(entry => entry.message?.role === "assistant").message;
			assert.deepEqual(message.content[0].replay, { source: { api: "openai-completions", provider: "local", model: "custom", baseUrl: `${url}/exact` }, payload: { reasoning_content: "完整思考" } });
		} finally { temp.cleanup(); }
	});
});
