import assert from "node:assert/strict";
import { test } from "node:test";
import { McpCatalog } from "../../src/mcp/catalog.ts";
import { McpError } from "../../src/mcp/types.ts";
import { MCP_LIMITS } from "../../src/mcp/util.ts";
import { deferred } from "../support/fixtures.ts";

const tool = (name: string) => ({ name, inputSchema: { type: "object" } });
const code = (expected: string) => (error: unknown) => error instanceof McpError && error.code === expected;

test("MCP failed pagination never publishes partial items or turns failure into an empty catalog", async () => {
	for (const mode of ["duplicate", "cursor", "pages", "bytes"]) {
		const catalog = new McpCatalog("tools", () => {});
		await catalog.load(async () => ({ items: [tool("old")] })); catalog.invalidate(); let pages = 0;
		await assert.rejects(catalog.load(async () => {
			pages++; return { items: [{ ...tool(mode === "duplicate" ? "same" : String(pages)), ...(mode === "bytes" ? { description: "x".repeat(MCP_LIMITS.catalogBytes / 2) } : {}) }],
				nextCursor: mode === "cursor" ? "repeated" : String(pages) };
		}), code(["pages", "bytes"].includes(mode) ? "limit" : "protocol"));
		assert.equal(catalog.getSnapshot().status, "failed"); assert.equal(catalog.getSnapshot().items[0].name, "old");
		assert.ok(pages <= MCP_LIMITS.catalogPages);
	}
});

test("MCP catalog notification during a load discards stale pages; concurrent waiters share the next load", async () => {
	const catalog = new McpCatalog("tools", () => {}), response = deferred<{ items: ReturnType<typeof tool>[] }>();
	const stale = catalog.load(() => response.promise); catalog.invalidate(); response.resolve({ items: [tool("stale")] });
	await assert.rejects(stale, code("catalog-changed")); assert.equal(catalog.getSnapshot().items.length, 0);
	const fresh = deferred<{ items: ReturnType<typeof tool>[] }>(); let calls = 0;
	const fetch = () => { calls++; return fresh.promise; };
	const cancelled = new AbortController(), one = catalog.load(fetch, cancelled.signal), two = catalog.load(fetch);
	cancelled.abort(); await assert.rejects(one, code("cancelled")); fresh.resolve({ items: [tool("fresh")] });
	assert.equal((await two)[0].name, "fresh"); assert.equal(calls, 1); assert.equal(catalog.getSnapshot().status, "ready");
	assert.throws(() => { (catalog.getSnapshot().items as unknown[]).push(tool("injected")); });
	catalog.unsupported(); await assert.rejects(catalog.load(fetch), code("unsupported"));
});
