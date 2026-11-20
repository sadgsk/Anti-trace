import type { ServerResponse } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { TestContext } from "node:test";
import type { Harness } from "../../src/harness/harness.ts";
import type { McpToolDefinition } from "../../src/mcp/types.ts";
import { createHttpFixture } from "./http-server.ts";

export interface RecordedCall { name: string; arguments: Record<string, unknown> }
export const echoDefinition: McpToolDefinition = {
	name: "echo", description: "Return the requested message",
	inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
};
type FixtureResult = object | void | Promise<object | void>;
interface ResourceRequest { method: string; id: number; params?: { uri?: string } }

/** Serve protocol requests over loopback and keep an independent record of actual execution. */
export async function httpMcpServer(t: TestContext, definitions: McpToolDefinition[], call:
	(request: RecordedCall, response: ServerResponse) => FixtureResult,
	resource?: (request: ResourceRequest, response: ServerResponse) => FixtureResult) {
	const calls: RecordedCall[] = [];
	const http = await createHttpFixture(t, async ({ body }, response) => {
		if (!body) { response.writeHead(405).end(); return; }
		const request = body as { method: string; id?: number; params: RecordedCall };
		if (request.id === undefined) { response.writeHead(202).end(); return; }
		let result: object | void;
		switch (request.method) {
			case "server/discover":
				result = { supportedVersions: ["2026-07-28"], capabilities: { tools: {}, ...(resource && { resources: {} }) },
					_meta: { "io.modelcontextprotocol/serverInfo": { name: "model-test", version: "1" } } };
				break;
			case "tools/list": result = { tools: definitions }; break;
			case "tools/call":
				calls.push(request.params);
				result = await call(request.params, response);
				if (!result) return; // The test controls completion, e.g. a disconnect after a write.
				break;
			default:
				if (resource && request.method.startsWith("resources/")) {
					result = await resource(body as ResourceRequest, response);
					if (!result) return;
					break;
				}
				response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({
					jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Unknown request" },
				}));
				return;
		}
		response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({
			jsonrpc: "2.0", id: request.id, result: { resultType: "complete", ttlMs: 0, cacheScope: "private", ...result },
		}));
	});
	return { ...http, calls };
}

export async function addStdioServer(harness: Harness, root: string, id: string, behavior = "normal") {
	const fixture = fileURLToPath(new URL("./mcp-server.mjs", import.meta.url));
	const log = join(root, id + "-events.jsonl");
	await harness.mcp.save("user", id, { command: process.execPath, args: [fixture, "legacy", log, behavior],
		startupTimeoutMs: process.platform === "win32" ? 20000 : 8000, requestTimeoutMs: 2000 });
	return () => {
		if (!existsSync(log)) return [];
		return readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(line =>
			JSON.parse(line) as { event: string; method?: string; params?: RecordedCall });
	};
}
