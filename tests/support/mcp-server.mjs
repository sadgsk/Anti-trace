// A wire-level fixture runs as an actual child process; no product code depends on it.
import { createInterface } from "node:readline";
import { appendFileSync } from "node:fs";
import { spawn } from "node:child_process";
const [era = "legacy", log, behavior = "normal"] = process.argv.slice(2);
const record = value => { if (log) appendFileSync(log, JSON.stringify(value) + "\n"); };
record({ event: "start", pid: process.pid, era });
if (behavior === "descendants") {
	const child = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], { stdio: "ignore" });
	record({ event: "descendant", pid: child.pid });
}
let revision = 0;
let subscription;
const send = value => { process.stdout.write(JSON.stringify(value) + "\n"); };
const caps = { tools: { listChanged: era !== "modern" || behavior === "notifications" }, resources: {}, prompts: {} };
const complete = result => era === "modern" ? { resultType: "complete", ttlMs: 0, cacheScope: "private", ...result } : result;
const lines = createInterface({ input: process.stdin });
lines.on("line", line => {
	const request = JSON.parse(line);
	record({ event: "request", method: request.method, id: request.id, params: request.params });
	if (request.id === undefined) return;
	if (request.method === "server/discover") {
		if (era === "silent") return;
		if (era !== "modern") { send({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Unknown method" } }); return; }
		send({ jsonrpc: "2.0", id: request.id, result: complete({ supportedVersions: ["2026-07-28"], capabilities: caps,
			_meta: { "io.modelcontextprotocol/serverInfo": { name: "fixture", version: "1" } } }) }); return;
	}
	let result;
	switch (request.method) {
		case "subscriptions/listen":
			subscription = request.id;
			send({ jsonrpc: "2.0", method: "notifications/subscriptions/acknowledged", params: { _meta: { "io.modelcontextprotocol/subscriptionId": subscription }, notifications: request.params.notifications } }); return;
		case "initialize": result = { protocolVersion: "2025-11-25", capabilities: caps, serverInfo: { name: "fixture", version: "1" }, instructions: "Fixture instructions" }; break;
		case "tools/list":
			if (behavior === "bad-catalog") { result = { tools: [{ name: "bad", inputSchema: "invalid" }] }; break; }
			if (behavior === "huge") { process.stdout.write("x".repeat(9 * 1024 * 1024)); return; }
			result = request.params?.cursor ? { tools: [{ name: "error", inputSchema: { type: "object" } }] }
				: { tools: [{ name: revision ? "changed" : "echo", description: "Echo", inputSchema: { type: "object", properties: { text: { type: "string" } } } }], nextCursor: "page-2" }; break;
		case "resources/list": result = { resources: [{ name: "notes", uri: "fixture://notes" }] }; break;
		case "resources/templates/list": result = { resourceTemplates: [{ name: "note", uriTemplate: "fixture://notes/{id}" }] }; break;
		case "resources/read": result = { contents: [{ uri: request.params.uri, text: "resource body" }] }; break;
		case "prompts/list": result = { prompts: [{ name: "review", arguments: [{ name: "topic", required: true }] }] }; break;
		case "prompts/get": result = { messages: [{ role: "user", content: { type: "text", text: request.params.arguments.topic } }] }; break;
		case "tools/call":
			if (request.params.arguments?.disconnect) { process.exit(0); }
			if (request.params.arguments?.change) { revision++; send({ jsonrpc: "2.0", method: "notifications/tools/list_changed", ...(subscription ? { params: { _meta: { "io.modelcontextprotocol/subscriptionId": subscription } } } : {}) }); }
			if (request.params.arguments?.endSubscription && subscription) send({ jsonrpc: "2.0", id: subscription, result: complete({}) });
			result = { content: [{ type: "text", text: request.params.arguments?.text ?? "echo" }], ...(request.params.name === "error" ? { isError: true } : {}) };
			if (request.params.arguments?.slow) { setTimeout(() => send({ jsonrpc: "2.0", id: request.id, result: complete(result) }), 1500); return; }
			break;
		default: send({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "unsupported" } }); return;
	}
	if (process.env.MCP_FIXTURE_SECRET) process.stderr.write(`token=${process.env.MCP_FIXTURE_SECRET}\n`);
	if (behavior === "delay" && request.method === "initialize") setTimeout(() => send({ jsonrpc: "2.0", id: request.id, result: complete(result) }), 250);
	else send({ jsonrpc: "2.0", id: request.id, result: complete(result) });
});
