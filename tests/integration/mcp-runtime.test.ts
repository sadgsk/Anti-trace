import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";
import { McpRuntime } from "../../src/mcp/runtime.ts";
import { McpError } from "../../src/mcp/types.ts";
import { tempWorkspace, waitFor } from "../support/fixtures.ts";

const fixturePath = fileURLToPath(new URL("../support/mcp-server.mjs", import.meta.url));
function fixture(t: TestContext) {
	let runtime: McpRuntime;
	const root = tempWorkspace(t, () => runtime.close()); runtime = new McpRuntime({ cwd: root, appHome: join(root, "user") });
	const log = join(root, "events.jsonl");
	const records = (): { event: string; pid?: number; method?: string }[] => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
	const add = (id: string, era = "legacy", behavior = "normal", extra: Record<string, unknown> = {}, scope: "user" | "project" = "user") => runtime.save(scope, id, {
		command: process.execPath, args: [fixturePath, era, log, behavior], startupTimeoutMs: process.platform === "win32" ? 20000 : 8000, requestTimeoutMs: 2000, ...extra,
	});
	return { runtime, root, log, records, add };
}
const code = (expected: string) => (error: unknown) => error instanceof McpError && error.code === expected;

for (const era of ["legacy", "modern", "silent"]) test(`MCP stdio auto negotiates ${era}, discovers pages and exposes real binding operations`, async t => {
	const f = fixture(t); await f.add("one", era);
	assert.equal(f.records().length, 0, "saving does not start any server");
	const snapshot = await f.runtime.connectServerAndDiscover("one");
	assert.equal(snapshot.protocolEra, era === "modern" ? "modern" : "legacy");
	assert.equal(snapshot.status, "ready"); assert.equal(snapshot.catalogs.tools.items.length, 2);
	assert.equal(snapshot.catalogs.resources.status, "unloaded");
	const binding = await f.runtime.acquireBinding();
	try {
		assert.deepEqual((await binding.listTools("one")).map(tool => tool.name), ["echo", "error"]);
		assert.equal((await binding.callTool("one", "echo", { text: "hello" })).content[0].type, "text");
		assert.equal((await binding.callTool("one", "error", {})).isError, true);
		assert.equal((await binding.listResources("one"))[0].uri, "fixture://notes");
		assert.equal((await binding.listResourceTemplates("one"))[0].uriTemplate, "fixture://notes/{id}");
		assert.equal((await binding.readResource("one", "fixture://notes")).contents[0].uri, "fixture://notes");
		assert.equal((await binding.listPrompts("one"))[0].name, "review");
		assert.equal((await binding.getPrompt("one", "review", { topic: "topic" })).messages[0].role, "user");
		await assert.rejects(f.runtime.reload(), code("busy"));
		assert.equal(f.records().filter(item => item.event === "start").length, 2, "one disposable probe plus one reused connection");
	} finally { binding.release(); }
	await assert.rejects(binding.callTool("one", "echo", {}), code("binding-invalid"));
	await f.runtime.close(); await f.runtime.close();
	for (const item of f.records().filter(item => item.event === "start")) assert.throws(() => process.kill(item.pid!, 0));
});

test("MCP project trust gates all process creation; overrides and tool policy remain effective", async t => {
	const f = fixture(t); await f.add("one", "legacy", "normal", { disabledTools: ["error"] }, "project");
	await assert.rejects(f.runtime.connectServerAndDiscover("one"), code("untrusted")); assert.equal(f.records().length, 0);
	await f.runtime.trust("one"); const binding = await f.runtime.acquireBinding();
	try { assert.equal(binding.servers.get("one")?.tools.length, 1); await assert.rejects(binding.callTool("one", "error", {}), code("disabled")); }
	finally { binding.release(); }
	await f.runtime.setEnabled("one", false); await assert.rejects(f.runtime.connectServerAndDiscover("one"), code("disabled"));
	await f.runtime.reload(); assert.equal(f.runtime.getSnapshot().servers[0].status, "disabled");
	await f.runtime.setEnabled("one", true); await f.runtime.reconnect("one"); assert.equal(f.runtime.getSnapshot().servers[0].status, "ready");
});

for (const era of ["legacy", "modern"]) test(`MCP ${era} catalog change invalidates old tools but preserves unrelated resource operations`, async t => {
	const f = fixture(t); await f.add("one", era, "notifications"); const binding = await f.runtime.acquireBinding();
	try {
		await binding.listResources("one");
		await assert.rejects(binding.callTool("one", "echo", { change: true }), code("catalog-changed"));
		await assert.rejects(binding.callTool("one", "echo", {}), code("catalog-changed"));
		assert.equal((await binding.readResource("one", "fixture://notes")).contents.length, 1);
		await waitFor(() => f.runtime.getSnapshot().servers[0].catalogs.tools.items[0]?.name === "changed", "catalog refresh");
	} finally { binding.release(); }
	const next = await f.runtime.acquireBinding(); try { assert.equal(next.servers.get("one")?.tools[0].name, "changed"); } finally { next.release(); }
});

test("MCP modern subscription loss invalidates bindings instead of keeping stale definitions", async t => {
	const f = fixture(t); await f.add("one", "modern", "notifications"); const binding = await f.runtime.acquireBinding();
	try {
		await assert.rejects(binding.callTool("one", "echo", { endSubscription: true }));
		await waitFor(() => f.runtime.getSnapshot().servers[0].status === "failed", "subscription invalidation");
		await assert.rejects(binding.callTool("one", "echo", {}), code("binding-invalid"));
	} finally { binding.release(); }
});

test("MCP cancellation is per waiter and per request, and a failed server does not block a binding", async t => {
	const f = fixture(t); await f.add("one", "legacy", "delay");
	const cancel = new AbortController(); const first = f.runtime.connectServerAndDiscover("one", cancel.signal);
	const second = f.runtime.connectServerAndDiscover("one"); cancel.abort();
	await assert.rejects(first, code("cancelled")); assert.equal((await second).status, "ready");
	await f.runtime.save("user", "broken", { command: join(f.root, "does-not-exist"), startupTimeoutMs: 2000 });
	const binding = await f.runtime.acquireBinding();
	try {
		assert.equal(binding.servers.size, 1);
		const requestCancel = new AbortController(); const request = binding.callTool("one", "echo", { slow: true }, { signal: requestCancel.signal });
		await waitFor(() => f.records().some(item => item.method === "tools/call"), "tool request"); requestCancel.abort();
		await assert.rejects(request, code("cancelled"));
		await binding.callTool("one", "echo", {});
		await assert.rejects(binding.callTool("one", "echo", { slow: true }, { timeoutMs: 40 }), code("timeout"));
	} finally { binding.release(); }
});

test("MCP catalog failure does not erase other capabilities; secret stderr is bounded and redacted", async t => {
	const f = fixture(t); await f.add("one", "legacy", "bad-catalog", { env: { MCP_FIXTURE_SECRET: "fixture-secret-never-show" } });
	const snapshot = await f.runtime.connectServerAndDiscover("one");
	assert.equal(snapshot.status, "ready"); assert.equal(snapshot.catalogs.tools.status, "failed");
	assert.equal((await f.runtime.list("one", "resources")).length, 1);
	assert.doesNotMatch(JSON.stringify(f.runtime.getSnapshot()), /fixture-secret-never-show/);
});

test("MCP transport loss is distinct from user cancellation and old bindings cannot use a replacement", async t => {
	const f = fixture(t); await f.add("one"); const binding = await f.runtime.acquireBinding();
	try { await assert.rejects(binding.callTool("one", "echo", { disconnect: true }), code("transport")); }
	finally { binding.release(); }
	await f.runtime.reconnect("one"); await assert.rejects(binding.callTool("one", "echo", {}), code("binding-invalid"));
});

test("MCP oversized stdio frame stops the connection with a limit diagnostic", async t => {
	// Allow the complete test frame to cross real pipes on a busy coverage runner.
	const f = fixture(t); await f.add("one", "legacy", "huge", { startupTimeoutMs: 20000, requestTimeoutMs: 15000 });
	await assert.rejects(f.runtime.connectServerAndDiscover("one"), code("limit"));
	assert.equal(f.runtime.getSnapshot().servers[0].error?.code, "limit");
});

test("MCP close reaps a cancelled probe and its descendant processes", async t => {
	const f = fixture(t); await f.add("one", "silent", "descendants");
	const connecting = f.runtime.connectServerAndDiscover("one");
	await waitFor(() => f.records().some(item => item.event === "descendant"), "probe descendant");
	await f.runtime.close(); await assert.rejects(connecting);
	for (const item of f.records().filter(item => item.event === "start" || item.event === "descendant")) {
		await waitFor(() => { try { process.kill(item.pid!, 0); return false; } catch { return true; } }, `process ${item.pid} exit`);
	}
});

test("MCP probe disposal and normal close both reap descendants", async t => {
	const f = fixture(t); await f.add("one", "modern", "descendants");
	assert.equal((await f.runtime.connectServerAndDiscover("one")).status, "ready");
	const descendants = f.records().filter(item => item.event === "descendant");
	assert.equal(descendants.length, 2);
	await waitFor(() => { try { process.kill(descendants[0].pid!, 0); return false; } catch { return true; } }, "probe descendant exit");
	assert.doesNotThrow(() => process.kill(descendants[1].pid!, 0), "the session remains live after probe disposal");
	await f.runtime.close();
	for (const item of f.records().filter(item => item.event === "start" || item.event === "descendant")) {
		await waitFor(() => { try { process.kill(item.pid!, 0); return false; } catch { return true; } }, `process ${item.pid} exit`);
	}
});
