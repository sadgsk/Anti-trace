import assert from "node:assert/strict";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { Type } from "typebox";
import { Harness, type HarnessModelSettings } from "../../src/harness/harness.ts";
import { PermissionPolicy } from "../../src/cli/permissions/permission-policy.ts";
import { loadSession } from "../../src/harness/session.ts";
import type { AgentTool, StreamFn } from "../../src/types.ts";
import { deferred, tempWorkspace, waitFor } from "../support/fixtures.ts";
import { messageText, testModel } from "../support/harness.ts";
import { createScriptedModel, type ModelRequest } from "../support/scripted-model.ts";

const call = (id: string, name: string, args: Record<string, unknown>) =>
	({ toolCalls: [{ id, name, arguments: args }] });
const start = (id: string, prompt: string) => call(id, "agent_task", { action: "start", prompt });
const wait = (id: string, agent_id: string) => call(id, "wait_agent", { agent_id });
function result(request: ModelRequest, callId: string) {
	const message = request.context.messages.find(m => m.role === "toolResult" && m.toolCallId === callId);
	assert.ok(message?.role === "toolResult", `Missing tool result for ${callId}`);
	assert.equal(message.isError, false, messageText(message));
	return JSON.parse(messageText(message)) as { agent_id: string; status: string; report?: string };
}

function fixture(t: TestContext, tools: AgentTool[] = []) {
	const parent = createScriptedModel(), child = createScriptedModel();
	const harnesses: Harness[] = [];
	const root = tempWorkspace(t, async () => { await Promise.all(harnesses.map(h => h.close())); });
	let bindings = 0;
	const streamFn: StreamFn = (model, context, options) =>
		(context.systemPrompt?.includes("general-purpose subagent") ? child : parent).streamFn(model, context, options);
	function open(settings?: Partial<HarnessModelSettings> & { resolveModel?: () => HarnessModelSettings }) {
		const harness = new Harness({ cwd: root, sessionsRoot: join(root, "sessions"), appHome: join(root, "app"),
			model: testModel, thinking: { effort: "high" }, apiKey: "fixture-private-key", streamFn, ...settings,
			toolSources: [{ acquire() {
				bindings++;
				return { tools, diagnostics: [], instructions: [], release() { bindings--; } };
			} }] });
		harnesses.push(harness);
		return harness;
	}
	return { harness: open(), root, parent, child, open, bindings: () => bindings };
}

function childPath(harness: Harness, id: string) {
	const file = harness.listSessions()[0]!.filePath;
	return join(dirname(file), loadSession(file).header.id, "subagents", `agent-${id}.jsonl`);
}

function tool(name: string, execute: AgentTool["execute"]): AgentTool {
	return { name, label: name, description: name, parameters: Type.Object({}), execute };
}
const reply = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });

for (const interactive of [false, true]) {
	test(`parallel child edits preserve both changes (${interactive ? "individual approvals" : "auto-edit"})`, { timeout: 15000 }, async t => {
		const f = fixture(t);
		const path = join(f.root, "data.txt");
		writeFileSync(path, "AAA\nBBB\n");
		const bothReady = deferred();
		let edits = 0;
		f.harness.setBeforeToolCall(async ({ toolCall }) => {
			if (toolCall.name === "edit") { if (++edits === 2) bothReady.resolve(); await bothReady.promise; }
			return undefined;
		});
		const policy = new PermissionPolicy(f.root, interactive, interactive ? "default" : "auto-edit");
		f.harness.setBeforeToolCall(policy.beforeToolCall);
		const edit = (req: ModelRequest) => {
			const line = messageText(req.context.messages[0]);
			return call("edit", "edit", { path: "data.txt", edits: [{ oldText: line, newText: line.toLowerCase() }] });
		};
		f.child.appendResponses(edit, edit, { text: "first edit finished" }, { text: "second edit finished" });
		f.parent.appendResponses({ toolCalls: ["AAA", "BBB"].flatMap(line => start(line, line).toolCalls) },
			req => ({ toolCalls: ["AAA", "BBB"].flatMap(line => wait("wait-" + line, result(req, line).agent_id).toolCalls) }), { text: "finished" });
		const run = f.harness.prompt("edit both lines");
		try {
			if (interactive) {
				await waitFor(() => Boolean(policy.getSnapshot().request), "first edit preview");
				const first = policy.getSnapshot().request!;
				const changedLine = first.agentSource!.summary.toLowerCase();
				policy.decide("allow");
				await waitFor(() => policy.getSnapshot().request?.agentSource?.agent_id !== first.agentSource!.agent_id &&
					Boolean(policy.getSnapshot().request), "second edit preview");
				assert.ok(policy.getSnapshot().request!.hunks!.some(h => h.lines.includes(" " + changedLine)));
				policy.decide("allow");
			}
			await run;
			assert.equal(readFileSync(path, "utf8"), "aaa\nbbb\n");
			for (const req of f.child.requests.slice(2)) {
				const last = req.context.messages.at(-1);
				assert.ok(last?.role === "toolResult" && !last.isError);
			}
		} finally { bothReady.resolve(); policy.dispose(); await f.harness.close(); await run; }
	});
}

test("a restored child stays paused until its configured model ID and provider match", { timeout: 15000 }, async t => {
	const entered = deferred();
	const f = fixture(t, [tool("hold", async (_id, _args, signal) => {
		entered.resolve();
		await new Promise<void>(resolve => signal!.addEventListener("abort", () => resolve(), { once: true }));
		return reply("paused");
	})]);
	const modelRef = { configPath: join(f.root, "byok.json"), modelKey: "main" };
	f.harness.configureModel({ model: testModel, modelRef, apiKey: "local" });
	f.parent.appendResponses(start("create", "use original model"), { text: "delegated" });
	f.child.appendResponses(call("hold", "hold", {}));
	await f.harness.prompt("delegate");
	await entered.promise;
	const id = result(f.parent.requests.at(-1)!, "create").agent_id;
	await f.harness.close();
	let configured = { ...testModel, id: "replacement" };
	const reopened = f.open({ resolveModel: () => ({ model: configured, modelRef, apiKey: "local" }) });
	assert.ok(await reopened.resumeAt(1));
	const [control, lookup] = ["agent_task", "wait_agent"].map(name => reopened.agent.state.tools.find(tool => tool.name === name)!);
	const resume = () => control.execute("resume", { action: "resume", agent_id: id });
	for (const changed of [{ ...testModel, id: "replacement" }, { ...testModel, provider: "replacement" }]) {
		configured = changed;
		await assert.rejects(resume, /原模型配置/);
		assert.deepEqual((await lookup.execute("wait", { agent_id: id })).details, { agent_id: id, status: "paused" });
		assert.equal(f.child.requests.length, 1);
		assert.equal(JSON.parse(readFileSync(childPath(reopened, id), "utf8").trimEnd().split("\n").at(-1)!).status, "paused");
	}
	configured = testModel;
	f.child.appendResponses({ text: "resumed" });
	await resume();
	assert.deepEqual((await lookup.execute("wait", { agent_id: id })).details, { agent_id: id, status: "completed", report: "resumed" });
	assert.equal(f.child.requests.at(-1)!.model.id, testModel.id);
});

test("a parent reads independently while a delegated tool runs and retrieves only its final report, twice", { timeout: 15_000 }, async t => {
	const release = deferred(), entered = deferred();
	const f = fixture(t, [tool("child_gate", async () => {
		entered.resolve(); await release.promise; return reply("PRIVATE_TOOL_VALUE");
	})]);
	writeFileSync(join(f.root, "config"), "PARENT_CONFIG");
	let id = "";
	f.child.appendResponses(call("inside", "child_gate", {}), { text: "PUBLIC_REPORT" });
	f.parent.appendResponses(start("create", "investigate callers"), req => {
		id = result(req, "create").agent_id;
		return call("independent", "read", { path: "config" });
	}, req => {
		assert.match(messageText(req.context.messages.at(-1)), /PARENT_CONFIG/);
		return wait("wait1", id);
	}, req => {
		assert.equal(result(req, "wait1").report, "PUBLIC_REPORT");
		return wait("wait2", id);
	}, { text: "parent done" });
	const run = f.harness.prompt("check callers and config");
	try {
		await waitFor(() => f.harness.agent.state.pendingToolCalls.has("wait1"), "parent read and wait");
		await entered.promise;
		assert.equal(f.bindings(), 2);
		assert.equal(f.harness.listSessions().length, 1);
		assert.match(readFileSync(childPath(f.harness, id), "utf8"), /child_gate/);
		assert.doesNotMatch(JSON.stringify(f.parent.requests), /PRIVATE_TOOL_VALUE|PUBLIC_REPORT/);
	} finally { release.resolve(); await run; }
	assert.equal(f.bindings(), 0);
	assert.deepEqual(result(f.parent.requests.at(-1)!, "wait1"), result(f.parent.requests.at(-1)!, "wait2"));
	assert.deepEqual(result(f.parent.requests.at(-1)!, "wait2"), { agent_id: id, status: "completed", report: "PUBLIC_REPORT" });
	const parentJson = readFileSync(f.harness.listSessions()[0]!.filePath, "utf8");
	assert.doesNotMatch(parentJson, /PRIVATE_TOOL_VALUE/);
	assert.doesNotMatch(JSON.stringify(f.parent.requests), /PRIVATE_TOOL_VALUE/);
	const childJson = readFileSync(childPath(f.harness, id), "utf8");
	assert.match(childJson, /PRIVATE_TOOL_VALUE/);
	assert.doesNotMatch(childJson, /fixture-private-key|PARENT_CONFIG/);
	assert.equal(f.child.requests[0]!.options?.thinking?.effort, "high");
	assert.ok(f.child.requests.every(req => !req.context.tools?.some(t => ["agent_task", "wait_agent"].includes(t.name))));
	assert.equal(f.parent.pendingResponses, 0);
});

test("completed child is durable and queryable while a parent batch is blocked", { timeout: 15_000 }, async t => {
	const release = deferred(), childEntered = deferred(), finishChild = deferred();
	const f = fixture(t, [
		tool("parent_gate", async () => { await release.promise; return reply("released"); }),
		tool("child_gate", async () => { childEntered.resolve(); await finishChild.promise; return reply("done"); }),
	]);
	let id = "";
	f.parent.appendResponses(start("create", "scan"), req => {
		id = result(req, "create").agent_id;
		return call("blocked", "parent_gate", {});
	}, { text: "done" });
	f.child.appendResponses(call("inner", "child_gate", {}), { text: "report ready" });
	const run = f.harness.prompt("start");
	try {
		await waitFor(() => f.harness.agent.state.pendingToolCalls.has("blocked"), "parent tool to start");
		await childEntered.promise;
		finishChild.resolve();
		await waitFor(() => readFileSync(childPath(f.harness, id), "utf8").includes('"status":"completed"'), "child report to commit");
		assert.equal(f.parent.requests.length, 2);
		const lookup = f.harness.agent.state.tools.find(t => t.name === "wait_agent")!;
		assert.match(messageText({ role: "user", timestamp: 0, content: (await lookup.execute("lookup", { agent_id: id })).content }), /report ready/);
		assert.doesNotMatch(JSON.stringify(f.harness.getSessionHistory()), /report ready/);
	} finally { finishChild.resolve(); release.resolve(); await run; }
});

test("delegation pins the effective model turn and the task remains discoverable after compaction loses its ID", async t => {
	const f = fixture(t);
	const override = { ...testModel, id: "alternate-model" };
	f.harness.agent.prepareNextTurn = ({ toolResults }) => toolResults.some(r => r.toolCallId === "inspect")
		? { model: override, thinking: { effort: "low" } } : undefined;
	writeFileSync(join(f.root, "config"), "test config");
	f.parent.appendResponses(call("inspect", "read", { path: "config" }), start("create", "review config"), { text: "delegated" });
	f.child.appendResponses({ text: "private until waited" });
	await f.harness.prompt("review");
	const id = result(f.parent.requests.at(-1)!, "create").agent_id;
	await waitFor(() => readFileSync(childPath(f.harness, id), "utf8").includes('"status":"completed"'), "child completion");
	assert.equal(f.child.requests[0]!.model.id, override.id);
	assert.equal(f.child.requests[0]!.options?.thinking?.effort, "low");
	f.parent.appendResponses({ text: "ok" }, { text: "<summary>The configuration was reviewed.</summary>" }, { text: "done" });
	await f.harness.prompt("history ".repeat(15_000));
	f.harness.setContextWindow(40_000);
	assert.ok(await f.harness.compact());
	await f.harness.prompt("what about the delegated review?");
	const context = f.parent.requests.at(-1)!.context;
	assert.ok(!JSON.stringify(context.messages).includes(id));
	assert.ok(context.systemPrompt?.includes(id));
	assert.match(context.systemPrompt!, /review config/);
	assert.doesNotMatch(JSON.stringify(context), /private until waited/);
});

test("close and reopen pause background work, preserve completed reports and resume a write exactly once", { timeout: 15_000 }, async t => {
	const entered = deferred();
	const f = fixture(t, [tool("append_line", async () => {
		appendFileSync(join(f.root, "effect"), "once\n"); return reply("append confirmed");
	}), tool("hold", async (_id, _args, signal) => {
		entered.resolve();
		await new Promise<void>(resolve => signal!.addEventListener("abort", () => resolve(), { once: true }));
		return reply("hold stopped");
	})]);
	let id = "", doneId = "";
	f.parent.appendResponses(start("done", "finish now"), req => {
		doneId = result(req, "done").agent_id;
		return wait("report", doneId);
	}, start("active", "append once"), req => {
		id = result(req, "active").agent_id;
		return { text: "parent finished" };
	});
	f.child.appendResponses({ text: "earlier report" }, call("append", "append_line", {}), call("pending", "hold", {}));
	await f.harness.prompt("delegate");
	await entered.promise;
	assert.equal(f.bindings(), 1);
	await f.harness.close();
	assert.equal(f.bindings(), 0);
	const reopened = f.open();
	assert.equal(await reopened.resumeAt(1), true);
	const before = f.child.requests.length;
	f.parent.appendResponses(wait("status", id), req => {
		assert.equal(result(req, "status").status, "paused");
		assert.match(req.context.systemPrompt!, new RegExp(id));
		return wait("saved", doneId);
	}, req => {
		assert.equal(result(req, "saved").report, "earlier report");
		assert.equal(f.child.requests.length, before);
		return call("resume", "agent_task", { action: "resume", agent_id: id });
	}, req => {
		assert.equal(result(req, "resume").agent_id, id);
		return wait("final", id);
	}, { text: "all done" });
	f.child.appendResponses(req => {
		assert.match(JSON.stringify(req.context.messages), /append confirmed/);
		assert.match(JSON.stringify(req.context.messages), /hold stopped/);
		return { text: "resumed report" };
	});
	await reopened.prompt("resume");
	assert.equal(result(f.parent.requests.at(-1)!, "final").report, "resumed report");
	assert.equal(readFileSync(join(f.root, "effect"), "utf8"), "once\n");
	assert.equal(f.child.requests.length, before + 1);
});

for (const action of ["interrupt", "switch", "close"] as const) {
	test(`${action} seals dispatch and waits for both child tools to finish before publishing paused`, { timeout: 15_000 }, async t => {
		const release = deferred();
		const signals: AbortSignal[] = [];
		const f = fixture(t, [tool("hold", async (_id, _args, signal) => {
			signals.push(signal!);
			await release.promise;
			return reply("tool finished");
		})]);
		f.parent.appendResponses({ toolCalls: [
			...start("createA", "task A").toolCalls,
			...start("createB", "task B").toolCalls,
		] }, { text: "delegated" });
		f.child.appendResponses(call("hold", "hold", {}), call("hold", "hold", {}));
		await f.harness.prompt("start two tasks");
		const last = f.parent.requests.at(-1)!;
		const files = ["createA", "createB"].map(callId => childPath(f.harness, result(last, callId).agent_id));
		try {
			await waitFor(() => signals.length === 2, "both child tools entered");
			const oldControl = f.harness.agent.state.tools.find(t => t.name === "agent_task")!;
			const stopped = action === "interrupt" ? f.harness.abort() : action === "switch" ? f.harness.newSession() : f.harness.close();
			assert.ok(signals.every(signal => signal.aborted));
			if (action === "switch") {
				await assert.rejects(f.harness.manualCompact(), /Cannot compact/);
				await assert.rejects(f.harness.compact(), /Cannot compact/);
			}
			await assert.rejects(oldControl.execute("late-create", { action: "start", prompt: "late job" }), /stopping/);
			for (const path of files) assert.doesNotMatch(readFileSync(path, "utf8"), /"status":"paused"/);
			release.resolve();
			await stopped;
			for (const path of files) assert.match(readFileSync(path, "utf8"), /tool finished[\s\S]*"status":"paused"/);
			if (action === "switch") assert.deepEqual(f.harness.getSessionMessages(), []);
		} finally { release.resolve(); }
	});
}
