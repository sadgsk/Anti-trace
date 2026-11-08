import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { Type } from "typebox";
import { Agent } from "../../src/agent/agent.ts";
import { runAgentLoop } from "../../src/agent/loop.ts";
import { runCli } from "../../src/cli/main.ts";
import { Harness } from "../../src/harness/harness.ts";
import { appendEntry, createSessionFile, loadSession } from "../../src/harness/session.ts";
import { streamOpenAIChat } from "../../src/llm/openai-chat.ts";
import type {
	AgentLoopTurnUpdate, AgentTool, AssistantMessage, Model, ModelApi,
	StreamFn, StreamOptions, ThinkingLevel,
} from "../../src/types.ts";
import { createFakeStreamFn, type FakeStreamTurn } from "../support/fake-stream.ts";

function model(): Model {
	return {
		id: "test-model", name: "test-model", provider: "test-provider",
		api: "openai-completions", baseUrl: "https://test.invalid/v1", contextWindow: 128000,
	};
}

function recordRequests(turns: FakeStreamTurn[]) {
	const requests: Array<{ model: Model; options: StreamOptions }> = [];
	const fake = createFakeStreamFn(turns);
	const streamFn: StreamFn = (requestModel, context, options) => {
		requests.push({
			model: structuredClone(requestModel),
			options: { ...options, thinking: options?.thinking ? { ...options.thinking } : undefined },
		});
		return fake(requestModel, context, options);
	};
	return { streamFn, requests };
}

function withTempRoot() {
	const root = resolve(mkdtempSync(join(tmpdir(), "cli-agent-byok-")));
	return {
		root,
		cleanup() {
			assert.equal(dirname(root), resolve(tmpdir()));
			assert.match(basename(root), /^cli-agent-byok-/);
			rmSync(root, { recursive: true, force: true });
		},
	};
}

test("all five user levels reach the adapter without native field encoding", async () => {
	for (const effort of ["low", "medium", "high", "xhigh", "max"] satisfies ThinkingLevel[]) {
		const { streamFn, requests } = recordRequests([{ text: "ok" }]);
		const agent = new Agent({ streamFn, initialState: { model: model(), thinking: { enabled: true, effort } } });
		await agent.prompt("hello");
		assert.deepEqual(requests[0].options.thinking, { enabled: true, effort });
		assert.deepEqual(Object.keys(requests[0].options).sort(), ["apiKey", "maxTokens", "signal", "thinking"]);
	}
});

test("unspecified, disabled and re-enabled preferences retain the selected level", async () => {
	const { streamFn, requests } = recordRequests([{ text: "one" }, { text: "two" }, { text: "three" }]);
	const agent = new Agent({ streamFn, initialState: { model: model() } });
	await agent.prompt("default");
	assert.deepEqual(requests[0].options.thinking, { effort: "medium" });
	agent.state.thinking = { enabled: false, effort: "xhigh" };
	await agent.prompt("off");
	agent.state.thinking = { ...agent.state.thinking, enabled: true };
	await agent.prompt("on");
	assert.deepEqual(requests[1].options.thinking, { enabled: false, effort: "xhigh" });
	assert.deepEqual(requests[2].options.thinking, { enabled: true, effort: "xhigh" });
});

test("tool continuation keeps the run's model, adapter rules, capabilities, preference and static key", async () => {
	const initialModel: Model = { ...model(), maxOutputTokens: 2048, capabilities: { images: true }, adapter: { thinking: { mode: "effort", levels: ["low", "high"] } } };
	const initialThinking = { enabled: true, effort: "high" as ThinkingLevel };
	const { streamFn, requests } = recordRequests([
		{ toolCalls: [{ id: "c1", name: "change_state", arguments: {} }] },
		{ text: "continued" }, { text: "next run" },
	]);
	let agent: Agent;
	const tool: AgentTool = {
		name: "change_state", label: "change_state", description: "Change state during a tool call",
		parameters: Type.Object({}),
		async execute() {
			initialModel.id = "next-model";
			initialModel.baseUrl = "https://next.invalid/v1";
			initialModel.maxOutputTokens = 4096;
			initialModel.capabilities!.images = false;
			if (initialModel.adapter!.thinking?.mode === "effort") initialModel.adapter!.thinking.levels[0] = "changed";
			initialThinking.effort = "low";
			agent.state.thinking = { enabled: false, effort: "max" };
			agent.apiKey = "next-test-key";
			return { content: [{ type: "text", text: "changed" }], details: {} };
		},
	};
	agent = new Agent({
		streamFn, apiKey: "initial-test-key",
		initialState: { model: initialModel, thinking: initialThinking, tools: [tool] },
	});
	await agent.prompt("use tool");
	for (const request of requests) {
		assert.equal(request.model.id, "test-model");
		assert.equal(request.model.baseUrl, "https://test.invalid/v1");
		assert.equal(request.model.capabilities?.images, true);
		assert.deepEqual(request.model.adapter?.thinking, { mode: "effort", levels: ["low", "high"] });
		assert.equal(request.options.maxTokens, 2048);
		assert.equal(request.options.apiKey, "initial-test-key");
		assert.deepEqual(request.options.thinking, { enabled: true, effort: "high" });
	}
	await agent.prompt("new run");
	assert.equal(requests[2].model.id, "next-model");
	assert.equal(requests[2].options.maxTokens, 4096);
	assert.equal(requests[2].options.apiKey, "next-test-key");
	assert.deepEqual(requests[2].model.adapter?.thinking, { mode: "effort", levels: ["changed", "high"] });
	assert.deepEqual(requests[2].options.thinking, { enabled: false, effort: "max" });
});

test("prepareNextTurn explicitly overrides the next request and detaches returned objects", async () => {
	const { streamFn, requests } = recordRequests([
		{ toolCalls: [{ id: "c1", name: "noop", arguments: {} }] }, { text: "continued" },
	]);
	const nextModel = { ...model(), id: "override-model", provider: "override-provider", maxOutputTokens: 4096 };
	const nextThinking = { enabled: false, effort: "max" as ThinkingLevel };
	const tool: AgentTool = {
		name: "noop", label: "noop", description: "No-op", parameters: Type.Object({}),
		async execute() { return { content: [{ type: "text", text: "ok" }], details: {} }; },
	};
	const agent = new Agent({
		streamFn, getApiKey: provider => `${provider}-test-key`,
		initialState: { model: model(), thinking: { enabled: true, effort: "low" }, tools: [tool] },
		prepareNextTurn: ({ toolResults }): AgentLoopTurnUpdate | undefined =>
			toolResults.length ? { model: nextModel, thinking: nextThinking } : undefined,
		shouldStopAfterTurn: ({ toolResults }) => {
			if (toolResults.length) { nextModel.id = "later-mutation"; nextThinking.effort = "low"; }
			return false;
		},
	});
	await agent.prompt("use tool");
	assert.equal(requests[1].model.id, "override-model");
	assert.equal(requests[1].options.apiKey, "override-provider-test-key");
	assert.equal(requests[1].options.maxTokens, 4096);
	assert.deepEqual(requests[1].options.thinking, { enabled: false, effort: "max" });
	assert.deepEqual(agent.state.thinking, { enabled: true, effort: "low" });
});

test("context-only hook preserves thinking and an explicit request limit overrides the model default", async () => {
	const { streamFn, requests } = recordRequests([
		{ toolCalls: [{ id: "c1", name: "noop", arguments: {} }] }, { text: "ok" },
	]);
	const tool: AgentTool = {
		name: "noop", label: "noop", description: "No-op", parameters: Type.Object({}),
		async execute() { return { content: [{ type: "text", text: "ok" }], details: {} }; },
	};
	await runAgentLoop([], { systemPrompt: "", messages: [], tools: [tool] }, {
		model: { ...model(), maxOutputTokens: 4096 }, maxTokens: 512,
		thinking: { enabled: false, effort: "xhigh" }, convertToLlm: messages => messages,
		prepareNextTurn: ({ context }) => ({ context }),
	}, () => {}, undefined, streamFn);
	assert.equal(requests.length, 2);
	for (const request of requests) {
		assert.equal(request.options.maxTokens, 512);
		assert.deepEqual(request.options.thinking, { enabled: false, effort: "xhigh" });
	}
});

test("Harness initial preferences reach its Agent", async () => {
	const temp = withTempRoot();
	try {
		const { streamFn, requests } = recordRequests([{ text: "ok" }]);
		const harness = new Harness({
			cwd: process.cwd(), sessionsRoot: temp.root, apiKey: "test-key",
			model: { ...model(), adapter: { thinking: { mode: "toggle", format: "thinking-type" } } }, streamFn,
			thinking: { enabled: false, effort: "max" },
		});
		await harness.prompt("hello");
		assert.deepEqual(requests[0].options.thinking, { enabled: false, effort: "max" });
	} finally { temp.cleanup(); }
});

test("reasoning payloads round-trip through JSONL alongside legacy thinking blocks", () => {
	const temp = withTempRoot();
	try {
		const session = createSessionFile(process.cwd(), temp.root);
		const message: AssistantMessage = {
			role: "assistant", model: "test-model", stopReason: "stop", timestamp: 1,
			content: [
				{ type: "thinking", thinking: "legacy" },
				...(["openai-completions", "openai-responses", "anthropic-messages"] satisfies ModelApi[]).map(api => ({
					type: "thinking" as const, thinking: "display",
					replay: {
						source: { api, provider: "test-provider", model: "test-model", baseUrl: "https://test.invalid/v1" },
						payload: { signature: "test-signature", encrypted_content: "test-opaque", summary: [{ text: "summary" }] },
					},
				})),
			],
		};
		appendEntry(session, { type: "message", message });
		assert.deepEqual(loadSession(session.path).messages, [message]);
	} finally { temp.cleanup(); }
});

test("BYOK CLI config produces the existing Chat request without thinking fields", async () => {
	const temp = withTempRoot();
	const originalFetch = globalThis.fetch;
	const bodies: Record<string, unknown>[] = [];
	globalThis.fetch = async (_url, init) => {
		bodies.push(JSON.parse(String(init?.body)));
		return new Response('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
	};
	try {
		const configPath = join(temp.root, "byok.json");
		writeFileSync(configPath, JSON.stringify({
			version: 1,
			connections: { test: { api: "openai-completions", baseUrl: "https://test.invalid/v1", apiKey: "test-key" } },
			models: { main: { connection: "test", id: "test-model", contextWindow: 128000 } },
			currentModel: "main",
		}));
		const stdin = new PassThrough();
		const stdout = new PassThrough();
		const stderr = new PassThrough();
		stdin.end("hello");
		assert.equal(await runCli({
			streams: { stdin, stdout, stderr }, cwd: temp.root, sessionsRoot: temp.root, configPath,
		}), 0);
		assert.equal(bodies.length, 1);
		const body = bodies[0];
		assert.deepEqual(Object.keys(body).sort(), ["messages", "model", "stream", "stream_options", "tools"]);
		assert.equal(body.model, "test-model");
		assert.equal(body.stream, true);
		assert.deepEqual(body.stream_options, { include_usage: true });
		const messages = body.messages as Array<{ role: string; content: unknown }>;
		assert.equal(messages.length, 2);
		assert.equal(messages[0].role, "system");
		assert.equal(typeof messages[0].content, "string");
		assert.deepEqual(messages[1], { role: "user", content: "hello" });
		assert.deepEqual((body.tools as Array<{ function: { name: string } }>).map(tool => tool.function.name), ["read", "bash", "edit", "write"]);
	} finally { globalThis.fetch = originalFetch; temp.cleanup(); }
});

test("unimplemented protocols and unknown thinking rules fail before HTTP", async () => {
	const originalFetch = globalThis.fetch;
	let calls = 0;
	globalThis.fetch = async () => { calls++; throw new Error("HTTP must not be called"); };
	try {
		for (const api of ["openai-responses", "anthropic-messages"] satisfies ModelApi[]) {
			const result = await (await streamOpenAIChat({ ...model(), api }, { messages: [] }, { apiKey: "test-key" })).result();
			assert.equal(result.stopReason, "error");
			assert.match(result.errorMessage ?? "", /does not implement/);
		}
		for (const enabled of [true, false]) {
			const result = await (await streamOpenAIChat(model(), { messages: [] }, {
				apiKey: "test-key", thinking: { enabled, effort: "max" },
			})).result();
			assert.equal(result.stopReason, "error");
			assert.match(result.errorMessage ?? "", /没有思考控制规则/);
		}
		assert.equal(calls, 0);
	} finally { globalThis.fetch = originalFetch; }
});
