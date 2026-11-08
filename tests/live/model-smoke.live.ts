import assert from "node:assert/strict";
import test from "node:test";
import { loadByokConfig } from "../../src/config/byok.ts";
import { streamModel } from "../../src/llm/adapter.ts";

test("explicit provider smoke: a bounded text request completes", async (t) => {
	const configPath = process.env.CLI_AGENT_LIVE_CONFIG;
	assert.ok(configPath, "Use npm run test:live with an explicit --config");
	const config = loadByokConfig({ configPath, model: process.env.CLI_AGENT_LIVE_MODEL || undefined });
	const stream = await streamModel(config.model, { messages: [{ role: "user", timestamp: 0,
		content: [{ type: "text", text: "Reply with the single word READY." }] }] }, {
		apiKey: config.getApiKey(), maxTokens: Number(process.env.CLI_AGENT_LIVE_MAX_TOKENS),
		signal: AbortSignal.timeout(30000),
	});
	const message = await stream.result();
	assert.equal(message.stopReason, "stop", message.errorMessage);
	assert.ok(message.content.some((block) => block.type === "text" && block.text.trim()));
	t.diagnostic(`api=${config.model.api}; usage=${JSON.stringify(message.usage ?? {})}`);
});
