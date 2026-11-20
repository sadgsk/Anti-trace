import assert from "node:assert/strict";
import test from "node:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ReplController } from "../../src/cli/repl/repl-controller.ts";
import { createPromptDraft } from "../../src/cli/input/prompt-draft.ts";
import { loadSession } from "../../src/harness/session.ts";
import { createTestHarness, messageText } from "../support/harness.ts";
import { assertToolPairs, seedCompactionHistory } from "../support/compaction.ts";
import { deferred, waitFor } from "../support/fixtures.ts";
import { addStdioServer, echoDefinition, httpMcpServer } from "../support/mcp.ts";

const call = (id: string, name: string, args: Record<string, unknown> = {}) => ({ id, name, arguments: args });
const answer = (text: string) => ({ content: [{ type: "text", text }] });
const echo = "mcp__repo__echo";

test("MCP initialization follows credential validation, and excessive definitions fail before any model or compaction request", async t => {
	const f = createTestHarness(t, [], { unconfigured: true });
	const remote = await httpMcpServer(t, [{ ...echoDefinition, description: "long description ".repeat(1800) }], () => answer("unexpected"));
	await f.harness.mcp.save("user", "repo", { type: "http", url: remote.url });
	await assert.rejects(f.harness.prompt("unconfigured"), /模型/);
	assert.equal(remote.requests.length, 0);
	f.harness.configureModel({ model: { id: "model", name: "Small model", provider: "test", baseUrl: "http://127.0.0.1:1",
		api: "openai-completions", contextWindow: 4096 } });
	await assert.rejects(f.harness.prompt("no credential"), /凭据/);
	assert.equal(remote.requests.length, 0);
	f.harness.configureModel({ model: f.agent.state.model!, apiKey: "test-key" });
	await assert.rejects(f.harness.prompt("too many tool tokens"), /MCP/);
	assert.ok(remote.requests.length > 0);
	assert.equal(f.scripted.requests.length, 0);
	assert.equal(f.events.filter(event => event.type === "compaction_start").length, 0);
	await f.harness.mcp.setEnabled("repo", false);
	assert.ok(!f.agent.state.tools.some(tool => tool.name === echo));
});

test("MCP assembles one binding per submission, routes identical remote names independently and reuses connections", async t => {
	const f = createTestHarness(t, [
		{ toolCalls: [call("a", echo, { text: "first", trackProgress: true }), call("b", "mcp__docs__echo", { text: "second" })] },
		{ toolCalls: [call("c", echo, { text: "third" })] }, { text: "done" }, { text: "next" },
	]);
	f.harness.setBeforeToolCall(async () => undefined);
	t.after(() => f.harness.close());
	const acquire = t.mock.method(f.harness.mcp, "acquireBinding");
	const records = await addStdioServer(f.harness, f.root, "repo");
	f.harness.subscribe(event => {
		if (event.type === "tool_execution_update" && event.toolCallId === "a") writeFileSync(join(f.root, "repo-events.jsonl.progress"), "continue");
	});
	const docs = await httpMcpServer(t, [echoDefinition], req => answer(String(req.arguments.text)));
	await f.harness.mcp.save("user", "docs", { type: "http", url: docs.url });
	await f.harness.mcp.save("project", "untrusted", { type: "http", url: docs.url });
	await f.harness.mcp.save("user", "disabled", { type: "http", url: docs.url, enabled: false });
	await f.harness.mcp.save("user", "offline", { type: "http", url: "http://127.0.0.1:1/mcp", startupTimeoutMs: 500 });
	assert.deepEqual(records(), []);
	assert.equal(docs.requests.length, 0);
	await f.harness.prompt("Call the tools");
	assert.equal(acquire.mock.callCount(), 1, "both tool rounds share one binding");
	for (const request of f.scripted.requests) {
		const names = request.context.tools!.map(tool => tool.name);
		for (const name of [echo, "mcp__docs__echo", "read"]) assert.equal(names.filter(n => n === name).length, 1);
		assert.ok(names.every(name => !/untrusted|disabled|offline/.test(name)));
	}
	assert.deepEqual(docs.calls.map(req => [req.name, req.arguments]), [["echo", { text: "second" }]]);
	assert.deepEqual(records().filter(r => r.method === "tools/call").map(r => r.params?.arguments.text), ["first", "third"]);
	const results = f.agent.state.messages.filter(m => m.role === "toolResult");
	assert.deepEqual(results.map(m => [m.toolCallId, m.isError]), [["a", false], ["b", false], ["c", false]]);
	const updates = f.events.filter(event => event.type === "tool_execution_update" && event.toolCallId === "a");
	assert.match(JSON.stringify(updates), /Halfway/);
	assert.doesNotMatch(JSON.stringify(updates), /Late notification/);
	const lifecycle = f.events.flatMap(event => {
		if ("toolCallId" in event && event.toolCallId === "a") return [event.type];
		if (event.type === "message_end" && event.message.role === "toolResult" && event.message.toolCallId === "a") return ["result-persisted"];
		return [];
	});
	assert.deepEqual(lifecycle, ["tool_execution_start", "tool_execution_update", "tool_execution_end", "result-persisted"]);
	assertToolPairs(f.agent.state.messages);
	const starts = records().filter(r => r.event === "start").length;
	await f.harness.prompt("new turn");
	assert.equal(acquire.mock.callCount(), 2);
	assert.equal(records().filter(r => r.event === "start").length, starts);
	assert.equal(docs.requests.filter(r => (r.body as { method?: string })?.method === "tools/list").length, 1);
});

test("MCP argument failures, hidden or unknown tools, truncated calls and missing approvals send zero remote calls", async t => {
	const f = createTestHarness(t, [
		{ toolCalls: [call("invalid", echo, { text: 1 }), call("hidden", "mcp__repo__hidden"), call("unknown", "mcp_unknown")] },
		{ toolCalls: [call("no-policy", echo, { text: "no" })] }, { text: "handled" },
		{ stopReason: "length", toolCalls: [call("truncated", echo, { text: "incomplete" })] }, { text: "handled" },
	]);
	t.after(() => f.harness.close());
	const remote = await httpMcpServer(t, [echoDefinition, { ...echoDefinition, name: "hidden" }], () => answer("unexpected"));
	await f.harness.mcp.save("user", "repo", { type: "http", url: remote.url, disabledTools: ["hidden"] });
	await f.harness.prompt("invalid calls");
	assert.ok(!f.scripted.requests[0]!.context.tools?.some(tool => tool.name === "mcp__repo__hidden"));
	const approvals: string[] = [];
	f.harness.setBeforeToolCall(async context => { approvals.push(context.toolCall.id); return undefined; });
	await f.harness.prompt("truncated call");
	assert.deepEqual(approvals, []);
	assert.deepEqual(remote.calls, []);
	assert.deepEqual(f.agent.state.messages.filter(m => m.role === "toolResult").map(m => [m.toolCallId, m.isError]),
		[["invalid", true], ["hidden", true], ["unknown", true], ["no-policy", true], ["truncated", true]]);
});

test("MCP approval during a directory change cannot send a stale call; next submission uses the new definition", async t => {
	const f = createTestHarness(t, [{ toolCalls: [call("stale", echo, { text: "old" })] }, { text: "stale" },
		{ toolCalls: [call("fresh", "mcp__repo__changed", { text: "new" })] }, { text: "ok" }]);
	t.after(() => f.harness.close());
	const records = await addStdioServer(f.harness, f.root, "repo", "approval-change");
	f.harness.setBeforeToolCall(async context => {
		if (context.toolCall.id === "stale") {
			writeFileSync(join(f.root, "repo-events.jsonl.change"), "change");
			await waitFor(() => f.harness.mcp.getSnapshot().servers[0]?.catalogs.tools.items[0]?.name === "changed", "directory update");
		}
		return undefined;
	});
	await f.harness.prompt("stale");
	assert.equal(records().filter(r => r.method === "tools/call").length, 0);
	assert.equal(f.agent.state.messages.find(m => m.role === "toolResult")?.isError, true);
	await f.harness.prompt("fresh");
	assert.deepEqual(records().filter(r => r.method === "tools/call").map(r => r.params?.name), ["changed"]);
	assert.ok(!f.scripted.requests[2]!.context.tools?.some(tool => tool.name === echo));
});

test("MCP loop distinguishes business, protocol and uncertain transport/timeout outcomes and never retries remote writes", async t => {
	const cases = ["ok", "business", "protocol", "timeout", "disconnected"];
	const f = createTestHarness(t, cases.flatMap(id => [{ toolCalls: [call(id, echo, { text: id })] }, { text: "handled" }]));
	t.after(() => f.harness.close());
	f.harness.setBeforeToolCall(async () => undefined);
	const remote = await httpMcpServer(t, [echoDefinition], (req, response) => {
		switch (req.arguments.text) {
			case "business": return { ...answer("already exists"), isError: true };
			case "protocol": return { content: "not a valid content array" };
			case "timeout": return;
			case "disconnected": response.destroy(); return;
			default: return answer("done");
		}
	});
	await f.harness.mcp.save("user", "repo", { type: "http", url: remote.url, requestTimeoutMs: 500 });
	for (const id of cases) await f.harness.prompt("call " + id);
	assert.deepEqual(remote.calls.map(req => req.arguments.text), cases);
	const results = f.agent.state.messages.filter(m => m.role === "toolResult");
	assert.deepEqual(results.map(m => [m.toolCallId, m.isError]), cases.map(id => [id, id !== "ok"]));
	assert.match(messageText(results[1]), /already exists/);
	assert.equal(results[2]!.details.errorCode, "protocol");
	assert.equal(results[3]!.details.errorCode, "timeout");
	assert.equal(results[4]!.details.errorCode, "transport");
	for (const uncertain of results.slice(3)) assert.match(messageText(uncertain), /结果未确认/);
	for (const request of f.scripted.requests.filter((_, index) => index % 2 === 1)) {
		assertToolPairs(request.context.messages);
		assert.equal(request.context.messages.at(-1)?.role, "toolResult");
	}
});

test("MCP cancellation in flight pairs all outstanding calls, does not dispatch later calls, and releases the binding", async t => {
	const f = createTestHarness(t, [{ toolCalls: [call("active", echo, { text: "now" }), call("queued", echo, { text: "next" })] }, { text: "new turn" }]);
	t.after(() => f.harness.close());
	f.harness.setBeforeToolCall(async () => undefined);
	const received = deferred();
	const remote = await httpMcpServer(t, [echoDefinition], () => { received.resolve(); });
	await f.harness.mcp.save("user", "repo", { type: "http", url: remote.url });
	const run = f.harness.prompt("abort remotely");
	try { await Promise.race([received.promise, run.then(() => { throw new Error("Prompt ended without executing the MCP tool"); })]); }
	finally { f.harness.abort(); await run; }
	assert.deepEqual(remote.calls.map(r => r.arguments.text), ["now"]);
	assertToolPairs(f.agent.state.messages);
	assert.ok(f.agent.state.messages.filter(m => m.role === "toolResult").every(m => m.isError));
	assert.equal(f.scripted.requests.length, 1);
	await f.harness.mcp.setEnabled("repo", false);
	await f.harness.prompt("continue");
	assert.equal(messageText(f.agent.state.messages.at(-1)), "new turn");
});

test("MCP session permission is specific to a server and definition; /new and /resume require approval again", async t => {
	const ids = ["first", "again", "other", "schema", "fresh", "restored"];
	const f = createTestHarness(t, ids.flatMap(id => [{ toolCalls: [call(id, id === "other" ? "mcp__docs__echo" : echo, { text: id })] }, { text: "done" }]));
	t.after(() => f.harness.close());
	const definitions = [structuredClone(echoDefinition)];
	const remote = await httpMcpServer(t, definitions, request => answer(String(request.arguments.text)));
	for (const id of ["repo", "docs"]) await f.harness.mcp.save("user", id, { type: "http", url: remote.url });
	const repl = new ReplController({ harness: f.harness, cwd: f.root, interactive: true }); t.after(() => repl.dispose());
	const submit = (text: string) => repl.submit(createPromptDraft(text));
	const decide = async (id: string, choice: "deny" | "session") => {
		const run = submit(id);
		try { await waitFor(() => repl.permissions.getSnapshot().request?.id === id, "approval for " + id); }
		finally { repl.permissions.decide(choice); await run; }
	};
	await decide("first", "session");
	await submit("again");
	await decide("other", "deny");
	definitions[0]!.description = "Updated definition";
	await f.harness.mcp.reconnect("repo");
	await decide("schema", "session");
	await submit("/new");
	await decide("fresh", "session");
	await submit("/resume");
	assert.equal(repl.dialogs.getSnapshot()?.kind, "picker");
	repl.dialogs.target.actions?.["dialog:accept"]?.({ type: "key", name: "enter", raw: "", ctrl: false, alt: false, shift: false, meta: false });
	await decide("restored", "deny");
	assert.deepEqual(remote.calls.map(r => r.arguments.text), ["first", "again", "schema", "fresh"]);
});

test("MCP interrupt while permission is pending denies the whole outstanding batch without remote execution", async t => {
	const f = createTestHarness(t, [{ toolCalls: [call("pending", echo, { text: "write" }), call("later", echo, { text: "write again" })] }]);
	const remote = await httpMcpServer(t, [echoDefinition], () => answer("unexpected"));
	await f.harness.mcp.save("user", "repo", { type: "http", url: remote.url });
	const repl = new ReplController({ harness: f.harness, cwd: f.root, interactive: true, permissionMode: "auto-edit" });
	t.after(() => repl.dispose());
	const run = repl.submit(createPromptDraft("interrupt while waiting"));
	try { await waitFor(() => repl.permissions.getSnapshot().request?.id === "pending", "permission under auto-edit"); }
	finally { repl.interrupt(); await run; }
	assert.equal(repl.permissions.getSnapshot().request, null);
	assert.deepEqual(remote.calls, []);
	const results = f.agent.state.messages.filter(m => m.role === "toolResult");
	assert.deepEqual(results.map(m => [m.toolCallId, m.isError]), [["pending", true], ["later", true]]);
	assert.equal(f.scripted.requests.length, 1);
});

test("MCP overflow recovery retains the same binding, and offline session restoration never replays a call", async t => {
	const f = createTestHarness(t, [{ text: "old" }, { error: "maximum context length exceeded" },
		{ text: "<summary>summary</summary>" }, { toolCalls: [call("after-recovery", echo, { text: "result stored" })] }, { text: "finished" }]);
	t.after(() => f.harness.close());
	f.harness.setBeforeToolCall(async () => undefined);
	await seedCompactionHistory(f.harness);
	const remote = await httpMcpServer(t, [echoDefinition], request => answer(String(request.arguments.text)));
	await f.harness.mcp.save("user", "repo", { type: "http", url: remote.url });
	const acquire = t.mock.method(f.harness.mcp, "acquireBinding");
	await f.harness.prompt("recover");
	assert.equal(acquire.mock.callCount(), 1);
	assert.equal(remote.calls.length, 1);
	assertToolPairs(f.agent.state.messages);
	const saved = loadSession(f.harness.listSessions()[0]!.filePath);
	assert.ok(saved.messages.some(m => m.role === "toolResult" && m.details.kind === "mcp" && messageText(m).includes("result stored")));
	await f.harness.mcp.setEnabled("repo", false);
	f.harness.newSession(); assert.ok(f.harness.resumeAt(1));
	assert.ok(f.agent.state.messages.some(m => m.role === "toolResult" && m.toolCallId === "after-recovery"));
	assert.equal(acquire.mock.callCount(), 1);
	assert.equal(remote.calls.length, 1);
});
