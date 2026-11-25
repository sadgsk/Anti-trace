import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { McpConfigStore } from "../../src/config/mcp.ts";
import { getAppPaths } from "../../src/storage/app-paths.ts";
import { cli } from "../support/cli-process.ts";
import { tempWorkspace } from "../support/fixtures.ts";

test("MCP commands run without a model and CLI exit reaps its owned stdio connection", async t => {
	const root = tempWorkspace(t), home = join(root, "home"), events = join(root, "mcp-events.jsonl");
	const store = new McpConfigStore(root, getAppPaths({ cwd: root, appHome: home }));
	store.save("user", "fixture", { command: process.execPath, args: [fileURLToPath(new URL("../support/mcp-server.mjs", import.meta.url)), "legacy", events] });
	const env = { RESIDUALX_HOME: home, HOME: home, USERPROFILE: home, RESIDUALX_CONFIG: join(root, "missing.json") };
	const list = await cli(t, root, "/mcp list", env);
	assert.equal(list.code, 0, list.stderr); assert.match(list.stdout, /fixture.*disconnected/); assert.equal(existsSync(events), false);
	const connected = await cli(t, root, "/mcp reconnect fixture", env);
	assert.equal(connected.code, 0, connected.stderr); assert.match(connected.stdout, /fixture.*ready/); assert.match(connected.stdout, /2025-11-25/);
	const records = readFileSync(events, "utf8").trim().split("\n").map(line => JSON.parse(line)) as { event: string; pid?: number }[];
	for (const record of records.filter(record => record.event === "start")) assert.throws(() => process.kill(record.pid!, 0));
	const forbidden = await cli(t, root, "/mcp login fixture", env); assert.equal(forbidden.code, 1); assert.match(forbidden.stdout, /交互终端/);
});

test("MCP resource and prompt pipe commands return source material without a model; missing prompt argument exits nonzero", async t => {
	const root = tempWorkspace(t), home = join(root, "home"), log = join(root, "mcp.jsonl");
	const config = new McpConfigStore(root, getAppPaths({ cwd: root, appHome: home }));
	config.save("user", "docs", { command: process.execPath,
		args: [fileURLToPath(new URL("../support/mcp-server.mjs", import.meta.url)), "legacy", log] });
	const env = { RESIDUALX_HOME: home, RESIDUALX_CONFIG: join(root, "missing.json") };
	const resource = await cli(t, root, "/mcp-resource docs fixture://notes\n", env);
	assert.equal(resource.code, 0, resource.stderr + resource.stdout);
	assert.match(resource.stdout, /fixture:\/\/notes/);
	assert.match(resource.stdout, /resource body/);
	const prompt = await cli(t, root, '/mcp-prompt docs review {"topic":"two words"}\r\n', env);
	assert.equal(prompt.code, 0, prompt.stderr + prompt.stdout);
	assert.match(prompt.stdout, /two words/);
	const missing = await cli(t, root, "/mcp-prompt docs review {}\n", env);
	assert.equal(missing.code, 1);
	assert.match(missing.stdout + missing.stderr, /topic/);
	const methods = readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line).method as string | undefined);
	assert.equal(methods.filter(method => method === "resources/read").length, 1);
	assert.equal(methods.filter(method => method === "prompts/get").length, 1);
	assert.ok(!methods.includes("tools/call"));
});
