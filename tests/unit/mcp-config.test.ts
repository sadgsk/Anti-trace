import { getAppPaths } from "../../src/storage/app-paths.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { McpConfigStore, parseMcpConfig } from "../../src/config/mcp.ts";
import { McpRuntime } from "../../src/mcp/runtime.ts";
import { McpLocalState } from "../../src/mcp/local-state.ts";
import { McpError } from "../../src/mcp/types.ts";
import { tempWorkspace } from "../support/fixtures.ts";

test("MCP config merges whole entries, applies defaults, resolves paths and records sources", t => {
	const root = tempWorkspace(t), store = new McpConfigStore(root, getAppPaths({ cwd: root, appHome: join(root, "user") }));
	store.save("user", "shared", { command: "user-command", args: ["user"] });
	store.save("user", "only-user", { type: "http", url: "https://example.test/mcp" });
	store.save("project", "shared", { command: "./server.mjs" });
	const candidate = store.load(), shared = candidate.servers.find(server => server.id === "shared")!;
	assert.equal(shared.source.scope, "project"); assert.equal(shared.overridden?.scope, "user");
	assert.equal(shared.config.type, "stdio");
	if (shared.config.type !== "stdio") return;
	assert.deepEqual(shared.config.args, []); assert.equal(shared.config.cwd, store.cwd);
	assert.equal(shared.config.command, join(store.cwd, ".residualx", "server.mjs"));
	assert.equal(shared.config.requestTimeoutMs, 60000);
	store.save("project", "shared", undefined);
	assert.equal(store.load().servers.find(server => server.id === "shared")?.source.scope, "user");
	if (process.platform !== "win32") assert.equal(statSync(store.paths.user).mode & 0o777, 0o600);
});

test("MCP config rejects bad candidates and detects edits without overwriting the file", t => {
	const root = tempWorkspace(t), store = new McpConfigStore(root, getAppPaths({ cwd: root, appHome: join(root, "user") }));
	const before = store.save("project", "valid", { command: "node" });
	const bytes = readFileSync(store.paths.project, "utf8");
	const invalid = [ { command: "node", protocolMode: "auto" }, { type: "ftp", url: "ftp://example.test" },
		{ type: "http", url: "https://user:secret@example.test" }, { type: "http", url: "https://example.test", headers: { Host: "wrong" } },
		{ type: "http", url: "https://example.test", headers: { "X-Test": "a" }, envHeaders: { "x-test": "TOKEN" } },
		{ type: "http", url: "https://example.test", auth: { type: "oauth", clientSecretEnv: "SECRET" } },
		{ command: "node", requestTimeoutMs: 0 }, { command: "node", envVars: ["BAD=KEY"] } ];
	for (const candidate of invalid) { assert.throws(() => store.save("project", "valid", candidate), McpError); assert.equal(readFileSync(store.paths.project, "utf8"), bytes); }
	writeFileSync(store.paths.project, bytes + " ");
	assert.throws(() => store.save("project", "valid", { command: "changed" }, before.digests.project), /其他程序/);
	assert.throws(() => parseMcpConfig('{"mcpServers":{"__proto__":{"command":"node"}}}'), McpError);
	assert.throws(() => parseMcpConfig('{"mcpServers":{}} trailing'), McpError);
});

test("MCP bad reload retains effective config and trust excludes timeout-only changes", async t => {
	const root = tempWorkspace(t), runtime = new McpRuntime({ cwd: root, appHome: join(root, "user") }); t.after(() => runtime.close());
	await runtime.save("project", "one", { command: "node" });
	assert.equal(runtime.getSnapshot().servers[0].status, "untrusted");
	await runtime.trust("one"); const key = runtime.getConfig().servers[0].trustKey;
	await runtime.save("project", "one", { command: "node", requestTimeoutMs: 10 });
	assert.equal(runtime.getConfig().servers[0].trustKey, key); assert.equal(runtime.getSnapshot().servers[0].trusted, true);
	writeFileSync(runtime.config.paths.project, "{broken");
	await assert.rejects(runtime.reload(), McpError);
	assert.equal(runtime.getSnapshot().servers[0].id, "one"); assert.equal(runtime.getSnapshot().diagnostics[0].code, "config");
	writeFileSync(runtime.config.paths.project, JSON.stringify({ mcpServers: { one: { command: "changed" } } }));
	await runtime.reload(); assert.equal(runtime.getSnapshot().servers[0].trusted, false);
	await assert.rejects(runtime.trust("one", key), /变化/);
});

test("MCP malformed initial configuration is diagnostic and recoverable", async t => {
	const root = tempWorkspace(t), runtime = new McpRuntime({ cwd: root, appHome: join(root, "user") }); t.after(() => runtime.close());
	mkdirSync(dirname(runtime.config.paths.project), { recursive: true }); writeFileSync(runtime.config.paths.project, "broken");
	assert.equal(runtime.getSnapshot().servers.length, 0); assert.equal(runtime.getSnapshot().diagnostics[0].code, "config");
	writeFileSync(runtime.config.paths.project, '{"mcpServers":{}}'); await runtime.reload();
	assert.deepEqual(runtime.getSnapshot().diagnostics, []);
});

test("MCP private credentials preserve refresh identity and revoke identity on logout", t => {
	const root = tempWorkspace(t), state = new McpLocalState(join(root, "mcp"));
	const first = state.updateCredentials("endpoint", () => ({ token: "first" }));
	assert.equal(state.updateCredentials("endpoint", () => ({ token: "refreshed" })), first);
	assert.equal(state.getCredentials("other"), undefined); state.logout("endpoint");
	assert.notEqual(state.getCredentials("endpoint")!.identity, first);
	assert.deepEqual(state.getCredentials("endpoint")!.data, {});
	if (process.platform !== "win32") { assert.equal(statSync(join(root, "mcp")).mode & 0o777, 0o700); assert.equal(statSync(join(root, "mcp/credentials.json")).mode & 0o777, 0o600); }
});

test("MCP uses the unified application home with profile-private config and trust", async t => {
	const root = tempWorkspace(t), appHome = join(root, "application-data");
	const one = new McpRuntime({ cwd: root, appHome, profileId: "one" }), two = new McpRuntime({ cwd: root, appHome, profileId: "two" });
	t.after(async () => { await one.close(); await two.close(); });
	assert.deepEqual(one.getSnapshot().servers, []); assert.deepEqual(two.getSnapshot().servers, []);
	assert.equal(one.config.paths.user, join(appHome, "profiles", "one", "mcp.json"));
	assert.equal(one.config.stateDirectory, join(appHome, "profiles", "one", "mcp"));
	await one.save("user", "private", { command: "node" }); await two.reload(); assert.equal(two.getSnapshot().servers.length, 0);
	await one.save("project", "shared", { command: "node" }); await one.trust("shared"); await two.reload();
	assert.equal(one.getSnapshot().servers.find(server => server.id === "shared")?.trusted, true);
	assert.equal(two.getSnapshot().servers.find(server => server.id === "shared")?.trusted, false);
});
