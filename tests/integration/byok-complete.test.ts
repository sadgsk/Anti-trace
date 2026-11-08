import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { Type } from "typebox";
import { Agent } from "../../src/agent/agent.ts";
import { ByokRuntime } from "../../src/cli/byok-runtime.ts";
import { ReplController } from "../../src/cli/repl/repl-controller.ts";
import { createPromptDraft } from "../../src/cli/input/prompt-draft.ts";
import { runCli } from "../../src/cli/main.ts";
import { loadByokConfig } from "../../src/config/byok.ts";
import { CONNECTION_PRESETS } from "../../src/config/presets.ts";
import { Harness } from "../../src/harness/harness.ts";
import { summarizeConversation } from "../../src/harness/compaction.ts";
import { appendEntry, createSessionFile, loadSession } from "../../src/harness/session.ts";
import { streamOpenAIChat } from "../../src/llm/openai-chat.ts";
import { streamModel } from "../../src/llm/adapter.ts";
import { THINKING_LEVELS } from "../../src/llm/rules.ts";
import type { AgentMessage, Model, StreamFn, StreamOptions } from "../../src/types.ts";
import { createFakeStreamFn } from "../support/fake-stream.ts";

function fixture() {
	const root = resolve(mkdtempSync(join(tmpdir(), "byok-complete-")));
	return { root, path: join(root, "byok.json"), sessionsRoot: join(root, "sessions"),
		cleanup() {
			assert.equal(dirname(root), resolve(tmpdir()));
			assert.match(basename(root), /^byok-complete-/);
			rmSync(root, { recursive: true, force: true });
		},
	};
}
function model(preset: string, id: string): Model {
	return { id, name: id, provider: preset, api: "openai-completions", baseUrl: "https://test.invalid/v1",
		contextWindow: 128000, maxOutputTokens: 32000, adapter: { preset: preset as any } };
}
function config() {
	return { version: 1, connections: { a: { preset: "deepseek", apiKeyEnv: "KEY" } },
		models: {
			a: { connection: "a", id: "deepseek-flash", contextWindow: 128000, maxOutputTokens: 4096 },
			b: { connection: "a", id: "deepseek-v4-pro", contextWindow: 128000, maxOutputTokens: 4096 },
		}, currentModel: "a", thinking: { effort: "medium" } };
}
function setup(f: ReturnType<typeof fixture>, streamFn: StreamFn, env = { KEY: "fake-key" }) {
	writeFileSync(f.path, JSON.stringify(config()));
	let runtime: ByokRuntime;
	const harness = new Harness({ cwd: f.root, sessionsRoot: f.sessionsRoot, streamFn, resolveModel: ref => runtime.resolveModel(ref) });
	runtime = new ByokRuntime({ cwd: f.root, configPath: f.path, env }, c => {
		harness.configureModel({ model: c.model, modelRef: { configPath: c.configPath, modelKey: c.currentModel },
			thinking: c.thinking, getApiKey: c.getApiKey });
	}, () => harness.settings);
	assert.equal(runtime.reload().ok, true);
	return { harness, runtime };
}
function sse(...chunks: unknown[]) {
	return new Response(chunks.map(c => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n");
}
const delta = (data: unknown, finish: string | null = null) => ({ choices: [{ delta: data, finish_reason: finish }] });

test("regional presets bind the correct independent endpoints and credentials, explicit overrides win", () => {
	const f = fixture();
	try {
		const expected = {
			"kimi-cn": "https://api.moonshot.cn/v1", "kimi-global": "https://api.moonshot.ai/v1",
			"minimax-cn": "https://api.minimax.cn/v1", "minimax-global": "https://api.minimax.io/v1",
			"glm-cn": "https://open.bigmodel.cn/api/paas/v4", "glm-global": "https://api.z.ai/api/paas/v4",
			"glm-coding-cn": "https://open.bigmodel.cn/api/coding/paas/v4", "glm-coding-global": "https://api.z.ai/api/coding/paas/v4",
			"qwen-cn": "https://dashscope.aliyuncs.com/compatible-mode/v1", "qwen-global": "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
			"qwen-us": "https://dashscope-us.aliyuncs.com/compatible-mode/v1",
		};
		for (const [preset, baseUrl] of Object.entries(expected)) {
			writeFileSync(f.path, JSON.stringify({ ...config(),
				connections: { a: { preset, apiKey: `fake-${preset}` } } }));
			const c = loadByokConfig({ configPath: f.path });
			assert.equal(c.model.baseUrl, baseUrl);
			assert.equal(c.model.api, "openai-completions");
			assert.equal(c.getApiKey(c.model), `fake-${preset}`);
			assert.throws(() => c.getApiKey({ ...c.model, baseUrl: "https://foreign.invalid/v1" }), /连接/);
		}
		for (const preset of Object.keys(CONNECTION_PRESETS)) {
			writeFileSync(f.path, JSON.stringify({ ...config(), connections: { a: { preset, apiKey: "fake" } } }));
			assert.doesNotThrow(() => loadByokConfig({ configPath: f.path }));
		}
		writeFileSync(f.path, JSON.stringify({ ...config(), connections: { a: {
			preset: "qwen-cn", baseUrl: "https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1", apiKey: "fake",
			adapter: { thinking: { mode: "always" } },
		} } }));
		const c = loadByokConfig({ configPath: f.path });
		assert.match(c.model.baseUrl, /workspace/);
		assert.deepEqual(c.model.adapter?.thinking, { mode: "always" });
	} finally { f.cleanup(); }
});

test("commands preserve settings through new, model, reload and resume; bad candidates keep active state", async () => {
	const f = fixture();
	try {
		const { harness, runtime } = setup(f, createFakeStreamFn([{ text: "one" }, { text: "two" }]));
		const repl = new ReplController({ harness, byok: runtime });
		const submit = (text: string) => repl.submit(createPromptDraft(text));
		await submit("/effort max");
		await submit("/thinking on");
		await submit("/model b");
		assert.deepEqual(harness.settings.thinking, { effort: "max", enabled: true });
		await submit("hello");
		const session = harness.listSessions()[0].filePath;
		assert.equal(loadSession(session).settings?.modelRef?.modelKey, "b");
		const raw = readFileSync(session, "utf8");
		assert.doesNotMatch(raw, /fake-key|apiKey|Authorization/);
		assert.equal(loadSession(session).messages.length, 2);
		await submit("/thinking off");
		await submit("/effort low");
		await submit("/new");
		assert.deepEqual(harness.settings.thinking, { effort: "low", enabled: false });
		await submit("/model a");
		await submit("/reload");
		assert.deepEqual(harness.settings.thinking, { effort: "low", enabled: false });
		const before = structuredClone(harness.settings);
		await submit("/model missing");
		assert.deepEqual(harness.settings, before);
		writeFileSync(f.path, "broken");
		await submit("/reload");
		assert.deepEqual(harness.settings, before);
		writeFileSync(f.path, JSON.stringify(config()));
		await submit("/reload");
		assert.equal(harness.resumeAt(1), true);
		assert.equal(harness.settings.modelRef?.modelKey, "b");
		assert.deepEqual(harness.settings.thinking, { effort: "low", enabled: false });
		await submit("/thinking default");
		assert.deepEqual(harness.settings.thinking, { effort: "low" });
		await submit("/reload");
		assert.equal(harness.settings.modelRef?.modelKey, "b");
		const other = join(f.root, "other.json");
		writeFileSync(other, JSON.stringify(config()));
		await submit(`/config ${other}`);
		assert.deepEqual(harness.settings.thinking, { effort: "medium" });
		assert.equal(harness.settings.modelRef?.modelKey, "a");
		assert.ok(repl.getSnapshot().modelStatus?.includes("服务端默认"));
		repl.dispose();
	} finally { f.cleanup(); }
});

test("resume without a catalog preserves transcript and preferences; missing model warns and never loads a session-supplied file", async () => {
	const f = fixture();
	try {
		const { harness, runtime } = setup(f, createFakeStreamFn([{ text: "one" }, { text: "two" }]));
		runtime.selectModel("b");
		harness.setThinkingLevel("xhigh");
		await harness.prompt("saved");
		const noModel = new Harness({ cwd: f.root, sessionsRoot: f.sessionsRoot, streamFn: streamModel });
		assert.equal(noModel.resumeAt(1), true);
		assert.equal(noModel.agent.state.messages.length, 2);
		assert.equal(noModel.agent.state.model, undefined);
		assert.equal(noModel.settings.thinking.effort, "xhigh");
		assert.match(noModel.settingsWarning!, /未恢复模型/);
		const next = config();
		delete (next.models as any).b;
		writeFileSync(f.path, JSON.stringify(next));
		harness.newSession();
		runtime.reload({ model: "a" });
		harness.resumeAt(1);
		assert.equal(harness.settings.modelRef?.modelKey, "a");
		assert.match(harness.settingsWarning!, /已没有模型 b/);
		await harness.prompt("continued");
		assert.equal(loadSession(harness.listSessions()[0].filePath).settings?.modelRef?.modelKey, "a");
	} finally { f.cleanup(); }
});

test("prompt snapshots survive outside mutation, credentials rotate for tools, busy setters fail", async () => {
	const f = fixture();
	try {
		const calls: { model: Model; options?: StreamOptions }[] = [];
		const fake = createFakeStreamFn([
			{ toolCalls: [{ id: "t", name: "noop", arguments: {} }] }, { text: "done" },
		]);
		let key = "first-key";
		const harness = new Harness({ cwd: f.root, sessionsRoot: f.sessionsRoot, model: model("deepseek", "deepseek-flash"),
			thinking: { enabled: true, effort: "max" }, getApiKey: () => key,
			streamFn: (m, c, o) => { calls.push({ model: structuredClone(m), options: { ...o } }); return fake(m, c, o); } });
		harness.agent.state.tools = [{ name: "noop", label: "noop", description: "noop", parameters: Type.Object({}),
			execute: async () => {
				assert.throws(() => harness.setThinkingLevel("low"), /processing/);
				assert.throws(() => harness.newSession(), /processing/);
				harness.agent.state.model!.id = "outside-mutation";
				harness.agent.state.thinking = { enabled: false, effort: "low" };
				key = "second-key";
				return { content: [{ type: "text", text: "ok" }], details: {} };
			} }];
		await harness.prompt("test");
		assert.equal(calls.length, 2);
		assert.deepEqual(calls.map(c => c.options?.apiKey), ["first-key", "second-key"]);
		assert.deepEqual(calls.map(c => c.model.id), ["deepseek-flash", "deepseek-flash"]);
		for (const c of calls) assert.deepEqual(c.options?.thinking, { enabled: true, effort: "max" });
	} finally { f.cleanup(); }
});

test("hook switching resolves the target key; cross-host credential reuse is rejected", async () => {
	const f = fixture();
	try {
		const env = { KEY: "fake-a" };
		const configData = config();
		(configData.connections as any).b = { preset: "kimi-cn", apiKey: "fake-b" };
		configData.models.b.connection = "b";
		configData.models.b.id = "kimi-k2.6";
		writeFileSync(f.path, JSON.stringify(configData));
		const c = loadByokConfig({ configPath: f.path, env });
		const keys: unknown[] = [];
		const fake = createFakeStreamFn([{ toolCalls: [{ id: "t", name: "noop", arguments: {} }] }, { text: "ok" }]);
		const agent = new Agent({ initialState: { model: c.model, tools: [{ name: "noop", label: "noop", description: "noop", parameters: Type.Object({}), execute: async () => ({ content: [], details: {} }) }] },
			getApiKey: (_provider, m) => c.getApiKey(m), apiKey: "stale-key",
			prepareNextTurn: () => ({ model: c.models.b }),
			streamFn: (m, context, o) => { keys.push(o?.apiKey); return fake(m, context, o); } });
		await agent.prompt("test");
		assert.deepEqual(keys, ["fake-a", "fake-b"]);
		assert.throws(() => c.getApiKey({ ...c.model, endpoint: "https://foreign.invalid/infer" }), /连接/);
	} finally { f.cleanup(); }
});

test("summary retries share model/thinking/output caps and resolve a fresh key; abort cannot commit", async () => {
	const requests: StreamOptions[] = [];
	let keys = 0;
	const fake = createFakeStreamFn([{ toolCalls: [{ id: "t", name: "noop", arguments: {} }] }, { text: "<summary>saved</summary>" }]);
	const summary = await summarizeConversation({ model: { ...model("qwen", "qwen3.5-plus"), maxOutputTokens: 2048 },
		context: { messages: [] }, reserveTokens: 16384, thinking: { enabled: true, effort: "max" },
		getApiKey: () => `key-${++keys}`, streamFn: (m, c, o) => { requests.push({ ...o }); return fake(m, c, o); } });
	assert.match(summary, /saved/);
	assert.deepEqual(requests.map(r => r.apiKey), ["key-1", "key-2"]);
	for (const r of requests) {
		assert.equal(r.maxTokens, 2048);
		assert.deepEqual(r.thinking, { enabled: true, effort: "max" });
	}
	const controller = new AbortController();
	await assert.rejects(summarizeConversation({ model: model("deepseek", "deepseek-flash"), context: { messages: [] },
		reserveTokens: 16384, signal: controller.signal, getApiKey: () => { controller.abort(); return "fake"; },
		streamFn: () => { throw new Error("must not request after abort"); } }), /abort/i);
});

test("Harness automatic compaction and manual compaction use current settings and cancellation leaves history intact", async () => {
	const f = fixture();
	try {
		const calls: Array<{ model: Model; options: StreamOptions; summary: boolean }> = [];
		let turn = 0;
		let harness: Harness;
		let cancelSummary = false;
		const fake = createFakeStreamFn([
			{ text: "<summary>short</summary>" }, { text: "ok", usage: { input: 1200, output: 1 } },
			{ text: "<summary>manual</summary>" }, { text: "<summary>cancelled</summary>" },
		]);
		harness = new Harness({ cwd: f.root, sessionsRoot: f.sessionsRoot, model: { ...model("deepseek", "deepseek-flash"), contextWindow: 60000, maxOutputTokens: 4096 },
			thinking: { enabled: true, effort: "max" }, getApiKey: () => `key-${++turn}`,
			streamFn: (m, c, o) => {
				const summary = JSON.stringify(c.messages.at(-1)).includes("CRITICAL: Respond");
				calls.push({ model: structuredClone(m), options: { ...o }, summary });
				if (summary && cancelSummary) {
					assert.throws(() => harness.setThinkingEnabled(false), /processing/);
					harness.abort();
				}
				return fake(m, c, o);
			} });
		const history = (): AgentMessage[] => [
			{ role: "user", content: [{ type: "text", text: "old".repeat(30000) }], timestamp: 1 },
			{ role: "assistant", content: [{ type: "text", text: "old response" }], model: "deepseek-flash", stopReason: "stop", timestamp: 2 },
			{ role: "user", content: [{ type: "text", text: "recent".repeat(16000) }], timestamp: 3 },
		];
		harness.agent.state.messages = history();
		await harness.prompt("continue");
		assert.deepEqual(calls.map(c => c.summary), [true, false]);
		assert.deepEqual(calls.map(c => c.options.apiKey), ["key-1", "key-2"]);
		assert.deepEqual(calls[0].options.thinking, { enabled: true, effort: "max" });
		assert.equal(calls[0].options.maxTokens, 4096);
		assert.match(JSON.stringify(harness.agent.state.messages[0]), /short/);
		harness.setThinkingLevel("low");
		harness.agent.state.messages = history();
		assert.equal(await harness.compact(), true);
		assert.deepEqual(calls.at(-1)!.options.thinking, { enabled: true, effort: "low" });
		harness.agent.state.messages = history();
		const before = structuredClone(harness.agent.state.messages);
		const file = harness.listSessions()[0].filePath;
		const persisted = readFileSync(file, "utf8");
		cancelSummary = true;
		await assert.rejects(harness.compact(), /abort/i);
		assert.deepEqual(harness.agent.state.messages, before);
		assert.equal(readFileSync(file, "utf8"), persisted);
	} finally { f.cleanup(); }
});

const cases: Array<{ preset: string; id: string; field?: string; levels?: unknown[]; off: unknown; flags?: object }> = [
	{ preset: "openai", id: "gpt-5.2", field: "reasoning_effort", levels: ["low", "medium", "high", "xhigh", "xhigh"], off: { reasoning_effort: "none" } },
	{ preset: "deepseek", id: "deepseek-flash", field: "reasoning_effort", levels: ["low", "high", "max", "max", "max"], off: { thinking: { type: "disabled" } } },
	{ preset: "kimi", id: "kimi-k2.6", field: "thinking", levels: Array(5).fill({ type: "enabled", keep: "all" }), off: { thinking: { type: "disabled" } } },
	{ preset: "kimi", id: "kimi-k3", field: "reasoning_effort", levels: ["low", "high", "max", "max", "max"], off: "reject" },
	{ preset: "glm", id: "glm-4.7", field: "thinking", levels: Array(5).fill({ type: "enabled", clear_thinking: false }), off: { thinking: { type: "disabled" } } },
	{ preset: "qwen", id: "qwen3.5-plus", field: "thinking_budget", levels: [1024, 2048, 4096, 8192, 16384], off: { enable_thinking: false } },
	{ preset: "minimax", id: "MiniMax-M2.7", off: "reject", flags: { reasoning_split: true } },
	{ preset: "minimax", id: "MiniMax-M3", field: "thinking", levels: Array(5).fill({ type: "adaptive" }), off: { thinking: { type: "disabled" } }, flags: { reasoning_split: true } },
	{ preset: "minimax", id: "MiniMax-M3.1-Flash", field: "reasoning_effort", levels: [...THINKING_LEVELS], off: "reject" },
	{ preset: "grok", id: "grok-4.6", field: "reasoning_effort", levels: ["low", "medium", "high", "xhigh", "xhigh"], off: "reject" },
	{ preset: "gemini", id: "gemini-2.5-flash", field: "reasoning_effort", levels: ["low", "medium", "high", "high", "high"], off: { reasoning_effort: "none" } },
	{ preset: "gemini", id: "gemini-3-flash-preview", field: "reasoning_effort", levels: ["minimal", "low", "medium", "high", "high"], off: "reject" },
];
for (const item of cases) test(`${item.id}: five levels, true disable/rejection, server default, full tool continuation`, async () => {
	const original = globalThis.fetch;
	const bodies: any[] = [];
	let toolRound = false;
	globalThis.fetch = async (_url, init) => {
		const body = JSON.parse(String(init?.body));
		bodies.push(body);
		if (toolRound && !body.messages.some((m: any) => m.role === "tool")) {
			return sse(delta({ reasoning_content: "synthetic reasoning", tool_calls: [{ index: 0, id: "call", function: { name: "noop", arguments: "{}" },
				...(item.preset === "gemini" ? { extra_content: { google: { thought_signature: "opaque-signature" } } } : {}) }] }, "tool_calls"));
		}
		return sse(delta({ content: "ok" }, "stop"));
	};
	try {
		const m = model(item.preset, item.id);
		for (const [i, effort] of THINKING_LEVELS.entries()) {
			const reply = await (await streamOpenAIChat(m, { messages: [] }, { apiKey: "fake", thinking: { enabled: true, effort } })).result();
			assert.equal(reply.stopReason, "stop", reply.errorMessage);
			if (item.field) assert.deepEqual(bodies.at(-1)[item.field], item.levels![i]);
			for (const [key, value] of Object.entries(item.flags ?? {})) assert.deepEqual(bodies.at(-1)[key], value);
		}
		const before = bodies.length;
		const off = await (await streamOpenAIChat(m, { messages: [] }, { apiKey: "fake", thinking: { enabled: false, effort: "max" } })).result();
		if (item.off === "reject") { assert.equal(off.stopReason, "error"); assert.equal(bodies.length, before); }
		else {
			assert.equal(off.stopReason, "stop");
			for (const [key, value] of Object.entries(item.off as object)) assert.deepEqual(bodies.at(-1)[key], value);
			assert.equal(bodies.at(-1).thinking_budget, undefined);
		}
		await (await streamOpenAIChat(m, { messages: [] }, { apiKey: "fake", thinking: { effort: "max" } })).result();
		for (const key of ["thinking", "reasoning_effort", "enable_thinking", "thinking_budget"]) assert.equal(bodies.at(-1)[key], undefined);
		toolRound = true;
		let executed = 0;
		const agent = new Agent({ streamFn: streamModel, apiKey: "fake", initialState: { model: m, thinking: { enabled: true, effort: "low" },
			tools: [{ name: "noop", label: "noop", description: "noop", parameters: Type.Object({}), execute: async () => {
				executed++;
				return { content: [{ type: "text", text: "result" }], details: {} };
			} }] } });
		await agent.prompt("test");
		assert.equal(executed, 1);
		assert.equal(agent.state.messages.at(-1)?.role, "assistant");
		assert.equal((agent.state.messages.at(-1) as any).stopReason, "stop");
		const assistant = bodies.at(-1).messages.find((msg: any) => msg.role === "assistant");
		if (["deepseek", "kimi", "glm", "minimax"].includes(item.preset)) assert.equal(assistant.reasoning_content, "synthetic reasoning");
		if (item.preset === "gemini") assert.equal(assistant.tool_calls[0].extra_content.google.thought_signature, "opaque-signature");
	} finally { globalThis.fetch = original; }
});

test("MiniMax fragmented reasoning_details survives JSONL and replay; incomplete and foreign streams are not replayed", async () => {
	const f = fixture();
	const original = globalThis.fetch;
	let captured: any;
	let response = () => sse(
		delta({ reasoning_details: [{ type: "reasoning.text", id: "r", index: 0, text: "part " }] }),
		delta({ reasoning_details: [{ index: 0, text: "two" }] }),
		delta({ content: "answer" }, "stop"),
	);
	globalThis.fetch = async (_url, init) => { captured = JSON.parse(String(init?.body)); return response(); };
	try {
		const m = model("minimax", "MiniMax-M2.7");
		const reply = await (await streamOpenAIChat(m, { messages: [] }, { apiKey: "fake" })).result();
		assert.equal(reply.stopReason, "stop", reply.errorMessage);
		const file = createSessionFile(f.root, f.sessionsRoot);
		appendEntry(file, { type: "message", message: reply });
		response = () => sse(delta({ content: "ok" }, "stop"));
		const messages = loadSession(file.path).messages;
		await (await streamOpenAIChat(m, { messages }, { apiKey: "fake" })).result();
		assert.deepEqual(captured.messages[0].reasoning_details, [{ type: "reasoning.text", id: "r", index: 0, text: "part two" }]);
		assert.equal(captured.messages[0].reasoning_content, undefined);
		await (await streamOpenAIChat({ ...m, endpoint: "https://other.invalid/infer" }, { messages }, { apiKey: "fake" })).result();
		assert.equal(captured.messages[0].reasoning_details, undefined);
		response = () => sse(delta({ reasoning_details: [{ text: "partial" }] }, "length"));
		const truncated = await (await streamOpenAIChat(m, { messages: [] }, { apiKey: "fake" })).result();
		assert.ok(truncated.content.every(block => !("replay" in block)));
	} finally { globalThis.fetch = original; f.cleanup(); }
});

test("Gemini tool signatures survive JSONL; current-turn missing/foreign signatures fail before HTTP; older turns remain usable", async () => {
	const f = fixture();
	const original = globalThis.fetch;
	let count = 0;
	globalThis.fetch = async () => {
		count++;
		return count === 1 ? sse(delta({ tool_calls: [{ id: "t", function: { name: "noop", arguments: "{}" }, extra_content: { google: { thought_signature: "opaque" } } }] }, "stop"))
			: sse(delta({ content: "ok" }, "stop"));
	};
	try {
		const m = model("gemini", "gemini-3-flash-preview");
		const reply = await (await streamOpenAIChat(m, { messages: [] }, { apiKey: "fake" })).result();
		assert.equal(reply.stopReason, "toolUse", reply.errorMessage);
		const session = createSessionFile(f.root, f.sessionsRoot);
		appendEntry(session, { type: "message", message: { role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1 } });
		appendEntry(session, { type: "message", message: reply });
		appendEntry(session, { type: "message", message: { role: "toolResult", toolCallId: "t", toolName: "noop", isError: false, content: [], timestamp: 1 } });
		const messages = loadSession(session.path).messages;
		assert.equal((await (await streamOpenAIChat(m, { messages }, { apiKey: "fake" })).result()).stopReason, "stop");
		const before = count;
		const foreign = await (await streamOpenAIChat({ ...m, baseUrl: "https://foreign.invalid/v1" }, { messages }, { apiKey: "fake" })).result();
		assert.match(foreign.errorMessage!, /thought_signature/);
		assert.equal(count, before);
		const missing = structuredClone(messages);
		delete (missing[1].content[0] as any).replay;
		assert.equal((await (await streamOpenAIChat(m, { messages: missing }, { apiKey: "fake" })).result()).stopReason, "error");
		assert.equal(count, before);
		missing.push({ role: "user", content: [{ type: "text", text: "new turn" }], timestamp: 2 });
		assert.equal((await (await streamOpenAIChat(m, { messages: missing }, { apiKey: "fake" })).result()).stopReason, "stop");
	} finally { globalThis.fetch = original; f.cleanup(); }
});

test("thinking display preserves order, has no duplicates in pipe, and hiding never changes request settings or replay", async () => {
	const f = fixture();
	const original = globalThis.fetch;
	const bodies: any[] = [];
	globalThis.fetch = async (_url, init) => {
		bodies.push(JSON.parse(String(init?.body)));
		return sse(delta({ reasoning_content: "thought-A" }), delta({ content: "text-B" }), delta({ reasoning_content: "thought-C" }), delta({ content: "text-D" }, "stop"));
	};
	try {
		const { harness, runtime } = setup(f, streamModel);
		const repl = new ReplController({ harness, byok: runtime });
		await repl.submit(createPromptDraft("test"));
		assert.deepEqual(repl.getSnapshot().entries.filter(e => /thought-|text-/.test(e.text)).map(e => e.text),
			["[思考] thought-A", "text-B", "[思考] thought-C", "text-D"]);
		await repl.submit(createPromptDraft("/thinking-display off"));
		const start = repl.getSnapshot().entries.length;
		await repl.submit(createPromptDraft("test again"));
		assert.deepEqual(repl.getSnapshot().entries.slice(start).filter(e => /thought-|text-/.test(e.text)).map(e => e.text), ["text-Btext-D"]);
		assert.equal(bodies[0].thinking, undefined);
		assert.equal(bodies[1].thinking, undefined);
		assert.equal(bodies[1].messages.find((m: any) => m.role === "assistant").reasoning_content, "thought-Athought-C");
		repl.dispose();
		const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough();
		let output = "";
		stdout.on("data", chunk => { output += chunk.toString(); });
		stdin.end("pipe");
		writeFileSync(f.path, JSON.stringify({ ...config(), connections: { a: { preset: "deepseek", apiKey: "fake" } } }));
		assert.equal(await runCli({ cwd: f.root, sessionsRoot: f.sessionsRoot, streams: { stdin, stdout, stderr } }), 0);
		for (const word of ["thought-A", "text-B", "thought-C", "text-D"]) assert.equal(output.split(word).length - 1, 1, output);
	} finally { globalThis.fetch = original; f.cleanup(); }
});
