import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { McpRuntime } from "../../src/mcp/runtime.ts";
import { McpError } from "../../src/mcp/types.ts";
import { boundedFetch } from "../../src/mcp/http.ts";
import { MCP_LIMITS } from "../../src/mcp/util.ts";
import { tempWorkspace, deferred } from "../support/fixtures.ts";

interface Message { id?: number | string; method: string; params?: Record<string, unknown> }
const code = (expected: string) => (error: unknown) => error instanceof McpError && error.code === expected;
async function server(t: TestContext, handler: (request: IncomingMessage, response: ServerResponse, body: string) => void | Promise<void>) {
	const errors: unknown[] = [];
	const http = createServer(async (request, response) => {
		try { let body = ""; for await (const chunk of request) body += String(chunk); await handler(request, response, body); }
		catch (error) { errors.push(error); response.writeHead(500).end(); }
	});
	await new Promise<void>(resolve => http.listen(0, "127.0.0.1", resolve));
	t.after(async () => { http.closeAllConnections(); await new Promise<void>(resolve => http.close(() => resolve())); assert.deepEqual(errors, []); });
	const address = http.address(); assert.ok(address && typeof address === "object"); return `http://127.0.0.1:${address.port}`;
}
function fixture(t: TestContext) {
	let runtime: McpRuntime;
	const root = tempWorkspace(t, () => runtime.close()); runtime = new McpRuntime({ cwd: root, appHome: join(root, "user") });
	return { root, runtime };
}
const json = (response: ServerResponse, body: unknown, status = 200) => response.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
function rpc(response: ServerResponse, message: Message, era: "modern" | "legacy", caps: object = { tools: {} }) {
	if (message.id === undefined) { response.writeHead(202).end(); return; }
	let result: object;
	if (message.method === "server/discover") {
		if (era === "legacy") { json(response, { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Legacy" } }); return; }
		result = { supportedVersions: ["2026-07-28"], capabilities: caps, _meta: { "io.modelcontextprotocol/serverInfo": { name: "HTTP fixture", version: "1" } } };
	} else if (message.method === "initialize") result = { protocolVersion: "2025-11-25", capabilities: caps, serverInfo: { name: "HTTP fixture", version: "1" } };
	else if (message.method === "tools/list") result = { tools: [{ name: "ping", inputSchema: { type: "object" } }] };
	else result = { content: [{ type: "text", text: "pong" }] };
	json(response, { jsonrpc: "2.0", id: message.id, result: { ...result, ...(era === "modern" ? { resultType: "complete", ttlMs: 0, cacheScope: "private" } : {}) } });
}

for (const era of ["modern", "legacy"] as const) test(`MCP HTTP negotiates ${era} and forwards bearer/environment headers without leaking them`, async t => {
	const f = fixture(t), requests: Message[] = [];
	process.env.MCP_TEST_TOKEN = "private-test-bearer"; process.env.MCP_TEST_HEADER = "private-test-header";
	t.after(() => { delete process.env.MCP_TEST_TOKEN; delete process.env.MCP_TEST_HEADER; });
	const url = await server(t, (request, response, body) => {
		if (request.method !== "POST") { response.writeHead(405).end(); return; }
		assert.equal(request.headers.authorization, "Bearer private-test-bearer"); assert.equal(request.headers["x-fixture"], "private-test-header");
		const message = JSON.parse(body) as Message; requests.push(message); rpc(response, message, era);
	});
	await f.runtime.save("user", "http", { type: "http", url: `${url}/mcp`, auth: { type: "bearer", tokenEnv: "MCP_TEST_TOKEN" }, envHeaders: { "X-Fixture": "MCP_TEST_HEADER" } });
	const binding = await f.runtime.acquireBinding();
	try {
		assert.equal(binding.servers.size, 1); assert.equal(f.runtime.getSnapshot().servers[0].protocolEra, era);
		assert.equal((await binding.callTool("http", "ping", {})).content.length, 1);
		await assert.rejects(binding.listResources("http"), code("unsupported"));
		assert.doesNotMatch(JSON.stringify(f.runtime.getSnapshot()), /private-test/);
		assert.equal(requests.some(request => request.method === "initialize"), era === "legacy");
		assert.equal(requests[0].method, "server/discover");
	} finally { binding.release(); }
});

test("MCP HTTP outage times out without attempting legacy initialize and project trust blocks all traffic", async t => {
	const f = fixture(t), requests: Message[] = [];
	const url = await server(t, (_request, _response, body) => { if (body) requests.push(JSON.parse(body) as Message); });
	await f.runtime.save("project", "http", { type: "http", url, startupTimeoutMs: 100 });
	await assert.rejects(f.runtime.connectServerAndDiscover("http"), code("untrusted")); assert.equal(requests.length, 0);
	await f.runtime.trust("http"); await assert.rejects(f.runtime.connectServerAndDiscover("http"), code("timeout"));
	assert.deepEqual(requests.map(request => request.method), ["server/discover"]);
});

test("MCP HTTP authentication failure is not negotiated down to legacy", async t => {
	const f = fixture(t), methods: string[] = [];
	const url = await server(t, (_request, response, body) => {
		if (body) methods.push((JSON.parse(body) as Message).method);
		response.writeHead(401, { "WWW-Authenticate": "Bearer" }).end("private-error-body");
	});
	await f.runtime.save("user", "http", { type: "http", url });
	await assert.rejects(f.runtime.connectServerAndDiscover("http"), code("needs-auth"));
	assert.equal(methods.includes("initialize"), false); assert.doesNotMatch(JSON.stringify(f.runtime.getSnapshot()), /private-error-body/);
});

test("MCP a catalog waiter's short timeout does not cancel another waiter's shared request", async t => {
	const f = fixture(t); let pages = 0;
	const url = await server(t, (_request, response, body) => {
		if (!body) { response.writeHead(405).end(); return; }
		const message = JSON.parse(body) as Message;
		if (message.method === "resources/list") {
			pages++; setTimeout(() => json(response, { jsonrpc: "2.0", id: message.id, result: { resources: [{ name: "shared", uri: "fixture://shared" }] } }), 120); return;
		}
		rpc(response, message, "legacy", { resources: {} });
	});
	await f.runtime.save("user", "http", { type: "http", url }); await f.runtime.connectServerAndDiscover("http");
	const short = f.runtime.list("http", "resources", { timeoutMs: 30 }), long = f.runtime.list("http", "resources", { timeoutMs: 1000 });
	await assert.rejects(short, code("timeout")); assert.equal((await long)[0].name, "shared"); assert.equal(pages, 1);
});

test("MCP modern tools enforce valid header mappings and preserve a bound definition during calls", async t => {
	const f = fixture(t); let mirrored: string | string[] | undefined;
	const url = await server(t, (request, response, body) => {
		if (!body) { response.writeHead(405).end(); return; }
		const message = JSON.parse(body) as Message;
		if (message.method === "tools/list") {
			json(response, { jsonrpc: "2.0", id: message.id, result: { resultType: "complete", ttlMs: 0, cacheScope: "private", tools: [
				{ name: "good", inputSchema: { type: "object", properties: { label: { type: "string", "x-mcp-header": "Label" } } } },
				{ name: "bad", inputSchema: { type: "object", properties: { label: { type: "number", "x-mcp-header": "Label" } } } },
			] } }); return;
		}
		if (message.method === "tools/call") mirrored = request.headers["mcp-param-label"];
		rpc(response, message, "modern");
	});
	await f.runtime.save("user", "http", { type: "http", url }); const binding = await f.runtime.acquireBinding();
	try { assert.deepEqual(binding.servers.get("http")?.tools.map(tool => tool.name), ["good"]); await binding.callTool("http", "good", { label: "hello" }); assert.equal(mirrored, "hello"); }
	finally { binding.release(); }
});

test("MCP HTTP JSON and SSE event limits apply before parsing; cancellation closes the response", async t => {
	const url = await server(t, (request, response) => {
		response.writeHead(200, { "Content-Type": request.url === "/sse" ? "text/event-stream" : "application/json" });
		response.end((request.url === "/sse" ? "data: " : "") + "x".repeat(MCP_LIMITS.messageBytes + 1));
	});
	const controller = new AbortController(), fetch = boundedFetch(controller.signal);
	for (const path of ["/json", "/sse"]) { const response = await fetch(url + path); await assert.rejects(response.text(), code("limit")); }
	controller.abort(); await assert.rejects(fetch(url));
});

test("MCP OAuth explicit login registers a client, validates state and PKCE, saves privately, refreshes and logs out", async t => {
	const f = fixture(t); let url = "", challenge = "", redirect = "", refreshed = false, needsRefresh = false;
	const grants: string[] = [], mcpMethods: string[] = [];
	url = await server(t, (request, response, body) => {
		const path = new URL(request.url!, url).pathname;
		if (path.includes(".well-known/oauth-protected-resource")) { json(response, { resource: `${url}/mcp`, authorization_servers: [url] }); return; }
		if (path === "/.well-known/oauth-authorization-server") {
			json(response, { issuer: url, authorization_endpoint: `${url}/authorize`, token_endpoint: `${url}/token`, registration_endpoint: `${url}/register`,
				response_types_supported: ["code"], code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"], authorization_response_iss_parameter_supported: true }); return;
		}
		if (path === "/register") { const client = JSON.parse(body); redirect = client.redirect_uris[0]; json(response, { ...client, client_id: "fixture-client" }, 201); return; }
		if (path === "/token") {
			const form = new URLSearchParams(body), grant = form.get("grant_type")!; grants.push(grant);
			if (grant === "authorization_code") {
				assert.equal(form.get("code"), "test-code"); assert.equal(form.get("redirect_uri"), redirect);
				assert.equal(createHash("sha256").update(form.get("code_verifier")!).digest("base64url"), challenge);
			} else { assert.equal(form.get("refresh_token"), "private-refresh"); refreshed = true; }
			json(response, { access_token: refreshed ? "private-access-2" : "private-access-1", token_type: "Bearer", refresh_token: "private-refresh", expires_in: 3600 }); return;
		}
		if (path !== "/mcp") { response.writeHead(404).end(); return; }
		if (request.headers.authorization !== `Bearer ${needsRefresh ? "private-access-2" : "private-access-1"}`) {
			response.writeHead(401, { "WWW-Authenticate": `Bearer resource_metadata="${url}/.well-known/oauth-protected-resource/mcp"` }).end(); return;
		}
		if (request.method !== "POST") { response.writeHead(405).end(); return; }
		const message = JSON.parse(body) as Message; mcpMethods.push(message.method); rpc(response, message, "modern");
	});
	await f.runtime.save("user", "oauth", { type: "http", url: `${url}/mcp`, auth: { type: "oauth" } });
	await assert.rejects(f.runtime.connectServerAndDiscover("oauth"), code("needs-auth"));
	assert.equal(f.runtime.getSnapshot().servers[0].status, "needs-auth");
	let callbackDone: Promise<void> | undefined;
	await f.runtime.login("oauth", destination => {
		callbackDone = (async () => {
			const authorization = new URL(destination); challenge = authorization.searchParams.get("code_challenge")!;
			const callback = new URL(authorization.searchParams.get("redirect_uri")!); callback.searchParams.set("code", "test-code");
			callback.searchParams.set("state", "wrong"); assert.equal((await fetch(callback)).status, 400);
			callback.searchParams.set("state", authorization.searchParams.get("state")!); callback.searchParams.set("iss", url);
			assert.equal((await fetch(callback)).status, 200);
		})();
	});
	await callbackDone; await f.runtime.connectServerAndDiscover("oauth");
	const stored = () => JSON.parse(readFileSync(join(f.runtime.config.stateDirectory, "credentials.json"), "utf8")) as { entries: Record<string, { identity: string }> };
	const identity = Object.values(stored().entries)[0].identity;
	needsRefresh = true; await f.runtime.reconnect("oauth");
	assert.equal(refreshed, true); assert.equal(Object.values(stored().entries)[0].identity, identity);
	assert.deepEqual(grants, ["authorization_code", "refresh_token"]);
	assert.doesNotMatch(JSON.stringify(f.runtime.getSnapshot()), /private-access|private-refresh|test-code/);
	await f.runtime.logout("oauth"); assert.notEqual(Object.values(stored().entries)[0].identity, identity);
	assert.doesNotMatch(readFileSync(join(f.runtime.config.stateDirectory, "credentials.json"), "utf8"), /private-access|private-refresh/);
	assert.ok(mcpMethods.includes("server/discover")); assert.equal(mcpMethods.includes("initialize"), false);
});

test("MCP OAuth cancel closes its loopback callback and runtime.close waits for login cleanup", async t => {
	const f = fixture(t); let url = "", redirect = "";
	url = await server(t, (request, response) => {
		if (request.url?.includes("oauth-protected-resource")) json(response, { resource: `${url}/mcp`, authorization_servers: [url] });
		else if (request.url?.includes("oauth-authorization-server")) json(response, { issuer: url, authorization_endpoint: `${url}/authorize`, token_endpoint: `${url}/token`, response_types_supported: ["code"], code_challenge_methods_supported: ["S256"] });
		else response.writeHead(404).end();
	});
	await f.runtime.save("user", "oauth", { type: "http", url: `${url}/mcp`, auth: { type: "oauth", clientId: "pre-registered" } });
	const redirected = deferred(); const login = f.runtime.login("oauth", value => { redirect = new URL(value).searchParams.get("redirect_uri")!; redirected.resolve(); });
	void login.catch(() => {}); await redirected.promise; await f.runtime.close(); await assert.rejects(login, code("cancelled"));
	await assert.rejects(fetch(redirect));
});
