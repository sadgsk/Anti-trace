import assert from "node:assert/strict";
import test from "node:test";
import { createTestHarness, messageText } from "../support/harness.ts";
import { assertToolPairs } from "../support/compaction.ts";
import { deferred } from "../support/fixtures.ts";
import { echoDefinition, httpMcpServer } from "../support/mcp.ts";

const list = { id: "catalog", name: "mcp_list_resources", arguments: { server: "docs" } };
const read = { id: "read", name: "mcp_read_resource", arguments: { server: "docs", uri: "docs://spec" } };
const template = { name: "page", uriTemplate: "docs://page/{id}" };
const item = { name: "index", uri: "docs://index" };

for (const broken of ["neither", "resources/list", "resources/templates/list", "both"]) {
	test(`MCP model resource lists preserve empty, partial and failed catalogs: ${broken}`, async t => {
		const f = createTestHarness(t, [{ toolCalls: [list] }, { text: "done" }]);
		f.harness.setBeforeToolCall(async () => undefined);
		const received: string[] = [];
		const remote = await httpMcpServer(t, [], () => assert.fail("unexpected tools/call"), (request, response) => {
			received.push(request.method);
			if (request.method === broken || broken === "both") {
				response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({
					jsonrpc: "2.0", id: request.id, error: { code: -32000, message: "PRIVATE_REMOTE_MESSAGE" },
				}));
				return;
			}
			if (request.method === "resources/list") return { resources: broken === "neither" ? [] : [item] };
			if (request.method === "resources/templates/list") return { resourceTemplates: broken === "neither" ? [] : [template] };
			assert.fail("unexpected resource content read");
		});
		await f.harness.mcp.save("user", "docs", { type: "http", url: remote.url });
		await f.harness.prompt("list optional documents");
		assert.deepEqual(received.sort(), ["resources/list", "resources/templates/list"]);
		const last = f.scripted.requests[1]!.context.messages.at(-1);
		assert.ok(last?.role === "toolResult");
		assert.equal(last.toolCallId, "catalog");
		assert.equal(last.isError, broken !== "neither");
		assert.doesNotMatch(messageText(last), /PRIVATE_REMOTE_MESSAGE/);
		const catalogs = f.harness.mcp.getSnapshot().servers[0]!.catalogs;
		assert.equal(catalogs.resources.status, ["both", "resources/list"].includes(broken) ? "failed" : "ready");
		assert.equal(catalogs.templates.status, ["both", "resources/templates/list"].includes(broken) ? "failed" : "ready");
		if (broken === "both") {
			assert.equal(last.details.errorCode, "protocol");
			return;
		}
		const json = last.content.find(block => block.type === "text" && block.text.startsWith("{"));
		assert.ok(json?.type === "text", "the usable part of the directory must reach the model as JSON");
		const data = JSON.parse(json.text);
		if (broken === "neither") assert.deepEqual(data, { server: "docs", resources: [], templates: [] });
		else if (broken === "resources/list") {
			assert.equal(typeof data.resourceListError, "string");
			assert.deepEqual(data.templates, [template]);
			assert.equal(data.resources, undefined);
		} else {
			assert.equal(typeof data.templateListError, "string");
			assert.deepEqual(data.resources, [item]);
			assert.equal(data.templates, undefined);
		}
	});
}

for (const [operation, first] of [["read", read], ["list", list]] as const) {
	test(`MCP aborts a pending resource ${operation} and pairs the remaining calls without dispatch`, async t => {
		const second = { ...read, id: "not-dispatched" };
		const f = createTestHarness(t, [{ toolCalls: [first, second] }]);
		f.harness.setBeforeToolCall(async () => undefined);
		const received: string[] = [], waiting = deferred();
		const remote = await httpMcpServer(t, [], () => assert.fail("unexpected tools/call"), req => {
			received.push(req.method);
			if (received.length === (operation === "list" ? 2 : 1)) waiting.resolve();
		});
		await f.harness.mcp.save("user", "docs", { type: "http", url: remote.url });
		const run = f.harness.prompt("inspect documents");
		try { await Promise.race([waiting.promise, run.then(() => assert.fail("prompt ended before resource request"))]); }
		finally { f.harness.abort(); await run; }
		assert.deepEqual(received.sort(), operation === "list" ? ["resources/list", "resources/templates/list"] : ["resources/read"]);
		const results = f.agent.state.messages.filter(m => m.role === "toolResult");
		assert.deepEqual(results.map(m => [m.toolCallId, m.isError]), [[first.id, true], [second.id, true]]);
		assert.equal(results[0]!.details.errorCode, "cancelled");
		assertToolPairs(f.agent.state.messages);
		assert.equal(f.scripted.requests.length, 1);
		await f.harness.mcp.setEnabled("docs", false);
	});
}

for (const status of [401, 403]) test(`MCP resource HTTP ${status} prevents further calls on the old binding and reports an auth failure`, async t => {
	const f = createTestHarness(t, [{ toolCalls: [read, { ...list, id: "after-auth" }] }, { text: "login required" }]);
	f.harness.setBeforeToolCall(async () => undefined);
	const received: string[] = [];
	const remote = await httpMcpServer(t, [echoDefinition], () => assert.fail("unexpected tools/call"), (request, response) => {
		received.push(request.method);
		response.writeHead(status, { "WWW-Authenticate": "Bearer" }).end("PRIVATE_REMOTE_MESSAGE");
	});
	await f.harness.mcp.save("user", "docs", { type: "http", url: remote.url });
	await f.harness.prompt("read and then list");
	assert.deepEqual(received, ["resources/read"]);
	const results = f.scripted.requests[1]!.context.messages.filter(m => m.role === "toolResult");
	assert.deepEqual(results.map(m => [m.toolCallId, m.isError, m.details.errorCode]), [
		["read", true, "needs-auth"], ["after-auth", true, "binding-invalid"],
	]);
	assert.equal(f.harness.mcp.getSnapshot().servers[0]?.status, "needs-auth");
	assert.doesNotMatch(JSON.stringify(results), /PRIVATE_REMOTE_MESSAGE/);
	assertToolPairs(f.agent.state.messages);
});
