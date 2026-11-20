import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { Harness } from "../../src/harness/harness.ts";
import type { ToolSource } from "../../src/harness/tool-source.ts";
import type { AgentTool } from "../../src/types.ts";
import { tempWorkspace } from "../support/fixtures.ts";
import { testModel } from "../support/harness.ts";
import { createScriptedModel } from "../support/scripted-model.ts";

const tool: AgentTool = { name: "from_source", label: "Source", description: "Test", parameters: { type: "object" },
	execute: async () => ({ content: [], details: {} }) };

test("partial source acquisition releases every acquired source and leaves the next submission usable", async t => {
	const root = tempWorkspace(t), model = createScriptedModel([{ text: "done" }]);
	let releases = 0, fail = true;
	const first: ToolSource = { acquire: () => ({ tools: [tool], instructions: ["SOURCE_NOTE"], diagnostics: [], release() { releases++; } }) };
	const second: ToolSource = { acquire(context) {
		assert.ok(context.reservedNames.has(tool.name));
		if (fail) throw new Error("source unavailable");
		return { tools: [], instructions: [], diagnostics: [], release() { releases++; } };
	} };
	const harness = new Harness({ cwd: root, appHome: join(root, "app"), streamFn: model.streamFn,
		model: testModel, apiKey: "test", toolSources: [first, second] });
	t.after(() => harness.close());
	harness.agent.state.systemPrompt = "custom prompt";
	await assert.rejects(harness.prompt("first"), /source unavailable/);
	assert.equal(releases, 1);
	assert.equal(model.requests.length, 0);
	await harness.mcp.reload();
	fail = false;
	await harness.prompt("second");
	assert.equal(releases, 3);
	assert.equal(model.requests[0]?.context.tools?.filter(t => t.name === tool.name).length, 1);
	assert.match(model.requests[0]?.context.systemPrompt ?? "", /custom prompt[\s\S]*SOURCE_NOTE/);
	assert.equal(harness.agent.state.systemPrompt, "custom prompt");
	assert.ok(!harness.agent.state.tools.some(t => t.name === tool.name));
});

test("oversized external tool definitions fail before the model call and release the run binding", async t => {
	const root = tempWorkspace(t), model = createScriptedModel();
	let released = false;
	const source: ToolSource = { acquire: () => ({
		tools: [{ ...tool, description: "x".repeat(16000) }], instructions: [], diagnostics: [], release() { released = true; },
	}) };
	const harness = new Harness({ cwd: root, appHome: join(root, "app"), streamFn: model.streamFn,
		model: { ...testModel, contextWindow: 1000 }, apiKey: "test", toolSources: [source] });
	t.after(() => harness.close());
	await assert.rejects(harness.prompt("run"), /MCP 工具/);
	assert.equal(model.requests.length, 0);
	assert.equal(released, true);
	assert.ok(!harness.agent.state.tools.some(t => t.name === tool.name));
	await harness.mcp.reload();
});
