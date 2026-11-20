import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import test from "node:test";
import { loadByokConfig } from "../../src/config/byok.ts";
import { Harness } from "../../src/harness/harness.ts";
import { streamModel } from "../../src/llm/adapter.ts";
import { tempWorkspace } from "../support/fixtures.ts";
import { messageText } from "../support/harness.ts";
import { httpMcpServer } from "../support/mcp.ts";

test("real LLM selects an MCP tool and returns the release service receipt", { timeout: 120000 }, async t => {
	const configPath = process.env.CLI_AGENT_LIVE_CONFIG;
	assert.ok(configPath, "Use npm run test:live:mcp with an explicit --config");
	const config = loadByokConfig({ configPath, model: process.env.CLI_AGENT_LIVE_MODEL || undefined });
	const root = tempWorkspace(t), receipt = randomUUID();
	const server = await httpMcpServer(t, [{ name: "get_receipt", description: "Return the current release verification receipt",
		inputSchema: { type: "object", properties: {} } }], () => ({ content: [{ type: "text", text: receipt }] }));
	const deadline = AbortSignal.timeout(110000);
	let requests = 0;
	const harness = new Harness({ cwd: root, appHome: join(root, "app"), model: { ...config.model, maxOutputTokens: Number(process.env.CLI_AGENT_LIVE_MAX_TOKENS || "2048") },
		getApiKey: () => config.getApiKey(), streamFn: (model, context, options) => {
			if (++requests > 6) throw new Error("Live MCP test exceeded six model requests");
			return streamModel(model, context, { ...options, signal: options?.signal ? AbortSignal.any([deadline, options.signal]) : deadline });
		} });
	t.after(() => harness.close());
	await harness.mcp.save("user", "release", { type: "http", url: server.url });
	harness.setBeforeToolCall(async ({ toolCall }) => toolCall.name === "mcp__release__get_receipt" ? undefined : { block: true, reason: "Only the fixture release service is in scope." });
	await harness.prompt("Ask the release service for its current verification receipt and reply with that exact receipt.");
	const last = harness.agent.state.messages.at(-1);
	const reason = last?.role === "assistant" ? last.stopReason : "no-assistant";
	const error = last?.role === "assistant" ? last.errorMessage ?? "" : "";
	const httpStatus = /(?:http\D{0,12}|status\D{0,8}|^)([45]\d\d)\b/i.exec(error)?.[1];
	const category = httpStatus ? "http-" + httpStatus
		: /fetch failed|connect|network|dns|ENOTFOUND|ECONN/i.test(error) ? "network"
		: /credential|api.?key|authentication|凭据|认证/i.test(error) ? "credentials"
		: /timeout|超时/i.test(error) ? "timeout" : error ? "provider-error" : "no-provider-error";
	const toolResults = harness.agent.state.messages.filter(m => m.role === "toolResult");
	const status = harness.mcp.getSnapshot().servers.find(s => s.id === "release");
	const diagnostic = `requests=${requests}, stop=${reason}, category=${category}, MCP=${status?.status}/${status?.error?.code ?? "ok"}, toolResults=${toolResults.length}, failedToolResults=${toolResults.filter(m => m.isError).length}`;
	assert.deepEqual(server.calls.map(call => call.name), ["get_receipt"], diagnostic);
	const result = harness.agent.state.messages.find(m => m.role === "toolResult" && m.toolName === "mcp__release__get_receipt");
	assert.ok(result?.role === "toolResult" && !result.isError && messageText(result).includes(receipt));
	assert.ok(messageText(harness.agent.state.messages.at(-1)).includes(receipt));
	t.diagnostic(`api=${config.model.api}; model requests=${requests}; MCP round-trip verified`);
});
