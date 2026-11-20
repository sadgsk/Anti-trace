import test from "node:test";
import assert from "node:assert/strict";
import { Check } from "typebox/value";
import { mcpToolName } from "../../src/mcp/tool-names.ts";
import { verifyToolSchema } from "../../src/mcp/tool-schema.ts";
import { McpToolSource } from "../../src/mcp/tool-source.ts";
import { McpResourceSource } from "../../src/mcp/resource-source.ts";
import type { JsonObject, McpBinding, McpServerBinding } from "../../src/mcp/types.ts";
import { testModel } from "../support/harness.ts";
import { tempWorkspace } from "../support/fixtures.ts";

test("MCP model names are stable, portable and distinguish lossy mappings and ambiguous delimiters", () => {
	assert.equal(mcpToolName("docs", "search"), "mcp__docs__search");
	const pairs = [["a", "b__c"], ["a__b", "c"], ["repo", "文"], ["repo", "字"], ["a", "a".repeat(90)], ["a_", "b"], ["a", "_b"]];
	const names = pairs.map(([id, tool]) => mcpToolName(id!, tool!));
	assert.ok(names.every(name => /^[A-Za-z0-9_-]{1,64}$/.test(name)));
	assert.equal(new Set(names).size, pairs.length);
	assert.deepEqual(names, pairs.map(([id, tool]) => mcpToolName(id!, tool!)));
});

test("MCP schema registration validates at schema positions and the Agent checker enforces local references", () => {
	const schema: JsonObject = { type: "object", $defs: { positive: { type: "integer", minimum: 1 } }, properties: {
		number: { $ref: "#/$defs/positive" }, sample: { const: { $ref: "user-data" } } }, required: ["number"], additionalProperties: false };
	verifyToolSchema(schema);
	assert.ok(Check(schema, { number: 1, sample: { $ref: "user-data" } }));
	assert.ok(!Check(schema, { number: 0 }));
	assert.ok(!Check(schema, { number: "1" }));
	const invalid: JsonObject[] = [{ $ref: "https://unused.invalid/schema" }, { $ref: "#/$defs/missing" }, { $ref: "#/properties/bad" },
		{ type: "invalid" }, { type: "object", required: "name" }, { type: "string", pattern: "[" }];
	for (const property of invalid) {
		assert.throws(() => verifyToolSchema({ type: "object", properties: { bad: property } }));
	}
	assert.throws(() => verifyToolSchema({ type: "object", description: "x".repeat(150000) }));
});

test("MCP registration isolates bad definitions, reports collisions and pins per-action permission identities", async t => {
	const server: McpServerBinding = {
		serverId: "docs", generation: 1, identity: "identity", toolRevision: 1, capabilities: { tools: true, prompts: false, resources: true },
		tools: [{ name: "ok", inputSchema: { type: "object" } }, { name: "broken", inputSchema: { type: "array" } },
			{ name: "reserved", inputSchema: { type: "object" } }], instructions: "REMOTE".repeat(1000), outputMaxBytes: 1024,
	};
	let calls = 0;
	const binding = { servers: new Map([["docs", server]]), async callTool() { calls++; return { content: [] }; } } as unknown as McpBinding;
	const context = { binding, model: testModel, outputDirectory: tempWorkspace(t), reservedNames: new Set(["mcp__docs__reserved"]) };
	const acquired = new McpToolSource().acquire(context);
	assert.deepEqual(acquired.tools.map(tool => tool.name), ["mcp__docs__ok"]);
	assert.equal(acquired.diagnostics.length, 2);
	assert.ok(acquired.instructions[0]!.length < 2200);
	assert.equal(acquired.tools[0]!.resolvePermission!({}).scopeKey, "identity");
	const resources = new McpResourceSource().acquire(context);
	const [list, read] = resources.tools;
	const first = read!.resolvePermission!({ server: "docs", uri: "file:///one" });
	assert.notEqual(first.actionKey, read!.resolvePermission!({ server: "docs", uri: "file:///two" }).actionKey);
	assert.notEqual(first.actionKey, list!.resolvePermission!({ server: "docs" }).actionKey);
	await acquired.release();
	assert.equal((await acquired.tools[0]!.execute("late", {})).isError, true);
	assert.equal(calls, 0);
	await resources.release();
});
