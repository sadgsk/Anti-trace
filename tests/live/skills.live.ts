import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadByokConfig } from "../../src/config/byok.ts";
import { Harness } from "../../src/harness/harness.ts";
import { streamModel } from "../../src/llm/adapter.ts";
import type { Context } from "../../src/types.ts";
import { tempWorkspace } from "../support/fixtures.ts";
import { writeSkill } from "../support/skills.ts";
import { messageText } from "../support/harness.ts";
import { parseSkill } from "../../src/harness/skills/loader.ts";

test("real LLM loads a skill using the tool, reads its resource, and returns its private token", { timeout: 120000 }, async t => {
	const configPath = process.env.CLI_AGENT_LIVE_CONFIG;
	assert.ok(configPath, "Use npm run test:live:skills with an explicit --config");
	const config = loadByokConfig({ configPath, model: process.env.CLI_AGENT_LIVE_MODEL || undefined });
	const root = tempWorkspace(t), token = `SKILL_PROOF_${randomUUID()}`;
	writeSkill(root, "live-proof", "Read proof.txt relative to this skill's base directory using the read tool. Reply with exactly the verification token from that file.", { description: "Use this skill to retrieve the private verification token for the live skills test." });
	writeFileSync(join(root, ".anti-trace", "skills", "live-proof", "proof.txt"), token);
	const requests: Context[] = [];
	const deadline = AbortSignal.timeout(110000);
	const harness = new Harness({ cwd: root, appHome: join(root, "app"), model: { ...config.model, maxOutputTokens: Number(process.env.CLI_AGENT_LIVE_MAX_TOKENS || "2048") },
		getApiKey: () => config.getApiKey(), streamFn: (model, context, options) => {
			if (requests.length >= 6) throw new Error("Live skill test exceeded six model requests");
			requests.push(structuredClone({ ...context, tools: context.tools?.map(({ name, description, parameters }) => ({ name, description, parameters })) }));
			return streamModel(model, context, { ...options, signal: options?.signal ? AbortSignal.any([options.signal, deadline]) : deadline });
		} });
	t.after(async () => { harness.abort(); await harness.agent.waitForIdle(); });
	await harness.prompt("Use the live-proof skill to retrieve its verification token. Load the skill through the skill tool, then follow its instructions. Do not guess the token.");
	const last = harness.agent.state.messages.at(-1);
	assert.ok(last?.role === "assistant", "Expected a final assistant message");
	assert.notEqual(last.stopReason, "error", last.errorMessage ?? "Provider request failed");
	assert.notEqual(last.stopReason, "aborted", last.errorMessage ?? "Provider request aborted");
	assert.ok(harness.agent.state.messages.some(message => message.role === "assistant" && message.content.some(block => block.type === "toolCall" && block.name === "skill")), "Real model must call skill");
	assert.ok(harness.agent.state.messages.some(message => message.role === "toolResult" && message.toolName === "skill" && !message.isError));
	assert.ok(harness.agent.state.messages.some(message => message.role === "toolResult" && message.toolName === "read" && messageText(message).includes(token)), "Real model must read the resource");
	assert.ok(messageText(harness.agent.state.messages.at(-1)).includes(token), "Real model must return the token found only in the resource");
	t.diagnostic(`api=${config.model.api}; model requests=${requests.length}; skill and resource round-trip verified`);
});

for (const source of ["project", "user"] as const) test(`real LLM creates a ${source} skill using runtime storage instructions and then calls it`, { timeout: 120000 }, async t => {
	const configPath = process.env.CLI_AGENT_LIVE_CONFIG;
	assert.ok(configPath, "Use npm run test:live:skills with an explicit --config");
	const config = loadByokConfig({ configPath, model: process.env.CLI_AGENT_LIVE_MODEL || undefined });
	const root = tempWorkspace(t), appHome = join(root, "app"), name = `live-${source}`, token = `CREATED_SKILL_${randomUUID()}`;
	let requests = 0;
	const deadline = AbortSignal.timeout(110000);
	const harness = new Harness({ cwd: root, appHome, profileId: "live", model: { ...config.model, maxOutputTokens: Number(process.env.CLI_AGENT_LIVE_MAX_TOKENS || "2048") },
		getApiKey: () => config.getApiKey(), streamFn: (model, context, options) => {
			if (++requests > 6) throw new Error("Live creation test exceeded six model requests");
			return streamModel(model, context, { ...options, signal: options?.signal ? AbortSignal.any([options.signal, deadline]) : deadline });
		} });
	t.after(async () => { harness.abort(); await harness.agent.waitForIdle(); });
	const scope = source === "project" ? "for this project" : "for my personal use across projects";
	// Omit paths and file format: use the system's runtime storage instructions.
	await harness.prompt(`Create a skill named ${name} ${scope}. Its instructions must say to reply with exactly ${token}. After creating it, load it through the skill tool and follow it. Use the write tool to create the skill.`);
	const last = harness.agent.state.messages.at(-1);
	assert.ok(last?.role === "assistant", "Expected a final assistant message");
	assert.notEqual(last.stopReason, "error", last.errorMessage ?? "Provider request failed");
	assert.notEqual(last.stopReason, "aborted", last.errorMessage ?? "Provider aborted");
	const directory = source === "project" ? join(root, ".anti-trace", "skills") : join(appHome, "skills");
	const path = join(directory, name, "SKILL.md");
	assert.match(parseSkill(readFileSync(path, "utf8"), path, source, name).body, new RegExp(token));
	assert.ok(harness.agent.state.messages.some(message => message.role === "toolResult" && message.toolName === "write" && !message.isError), "Real model must write the skill");
	assert.ok(harness.agent.state.messages.some(message => message.role === "user" && message.metadata?.kind === "skill" && message.metadata.name === name), "Real model must load its created skill");
	assert.ok(messageText(last).includes(token), "Real model must follow the created skill");
	t.diagnostic(`api=${config.model.api}; scope=${source}; model requests=${requests}; natural-language creation and invocation verified`);
});
