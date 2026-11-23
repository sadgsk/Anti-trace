import assert from "node:assert/strict";
import { appendFileSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import type { AgentMessage, ToolCall } from "../../src/types.ts";
import { SubagentManager, type SubagentRun } from "../../src/harness/subagents.ts";
import { appendEntry, createSessionFile, loadSession, readSessionRows, type SessionFile } from "../../src/harness/session.ts";
import { deferred, tempWorkspace } from "../support/fixtures.ts";

function batch(calls: ToolCall[]): AgentMessage {
	return { role: "assistant", content: calls, model: "test", stopReason: "toolUse", timestamp: 1 };
}

function fixture(parent: SessionFile, run: (context: SubagentRun) => Promise<string>) {
	let steering = false;
	const listeners = new Set<() => void>();
	const manager = new SubagentManager(parent, {
		settings: () => ({ thinking: { effort: "high" }, modelRef: { configPath: "local", modelKey: "test" } }),
		run, hasSteering: () => steering,
		subscribeSteering: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
	});
	const [control, wait] = manager.tools();
	type Result = { agent_id: string; status: string; report?: string; error?: string };
	const task = async (action: string, args: object, callId = action) => (await control.execute(callId, { action, ...args })).details as Result;
	return {
		manager, task, listeners, start: (prompt: string, callId = "create") => task("start", { prompt }, callId),
		wait: async (id: string, signal?: AbortSignal) => (await wait.execute("wait", { agent_id: id }, signal)).details as Result,
		steer(value = true) { steering = value; for (const listener of listeners) listener(); },
	};
}

test("pause waits for cleanup, overlapping resume starts exactly one new run, and completion is immutable", { timeout: 5000 }, async t => {
	const root = tempWorkspace(t);
	const parent = createSessionFile(root, root);
	const entered = deferred();
	const cancel = deferred();
	const releaseCleanup = deferred();
	const second = deferred<string>();
	let count = 0;
	const f = fixture(parent, async run => {
		assert.equal(run.settings.thinking.effort, "high");
		assert.deepEqual(run.settings.modelRef, { configPath: "local", modelKey: "test" });
		assert.equal(run.messages[0].content[0].type, "text");
		if (++count === 2) return second.promise;
		entered.resolve();
		run.signal.addEventListener("abort", () => cancel.resolve(), { once: true });
		await releaseCleanup.promise;
		return "discard canceled result";
	});
	try {
		const created = await f.start("private investigation");
		const args = { agent_id: created.agent_id };
		assert.equal(created.status, "running");
		assert.deepEqual(await f.start("private investigation"), created);
		assert.deepEqual(await f.task("resume", args), created);
		await entered.promise;
		const waiting = f.wait(created.agent_id);
		const pausing = f.task("pause", args);
		const resuming = [f.task("resume", args), f.task("resume", args)];
		await cancel.promise;
		assert.equal(count, 1);
		releaseCleanup.resolve();
		assert.equal((await pausing).status, "paused");
		assert.equal((await waiting).status, "paused");
		assert.deepEqual(await Promise.all(resuming), [created, created]);
		assert.equal(count, 2);
		second.resolve("final report");
		const expected = { ...args, status: "completed", report: "final report" };
		assert.deepEqual(await f.wait(created.agent_id), expected);
		assert.deepEqual(await f.wait(created.agent_id), expected);
		for (const action of ["pause", "resume"]) assert.deepEqual(await f.task(action, args), { ...args, status: "completed" });
		assert(!f.manager.catalog().includes("final report"));
	} finally {
		releaseCleanup.resolve();
		second.resolve("");
		await f.manager.close();
	}
});

test("wait observes steering before and after subscription, removes listeners and only consumes the winning event", { timeout: 5000 }, async t => {
	const root = tempWorkspace(t);
	const end = deferred<string>();
	const f = fixture(createSessionFile(root, root), async () => end.promise);
	try {
		const { agent_id } = await f.start("will finish on demand");
		f.steer();
		assert.deepEqual(await f.wait(agent_id), { agent_id, status: "interrupted" });
		assert.equal(f.listeners.size, 0);
		f.steer(false);
		const waiting = f.wait(agent_id);
		assert.equal(f.listeners.size, 1);
		f.steer();
		assert.deepEqual(await waiting, { agent_id, status: "interrupted" });
		assert.equal(f.listeners.size, 0);
		f.steer(false);
		const abort = new AbortController();
		const aborted = f.wait(agent_id, abort.signal);
		abort.abort();
		await assert.rejects(aborted, /abort/i);
		assert.equal(f.listeners.size, 0);
		const final = f.wait(agent_id);
		end.resolve("finished first");
		assert.equal((await final).report, "finished first");
		f.steer();
		assert.equal((await f.wait(agent_id)).report, "finished first");
		assert.equal(f.listeners.size, 0);
	} finally {
		end.resolve("");
		await f.manager.close();
	}
});

test("restoring a torn child and dangling parent start/wait repairs each result once; compaction and ownership survive reopening", { timeout: 5000 }, async t => {
	const root = tempWorkspace(t);
	const parent = createSessionFile(root, root);
	const create: ToolCall = { type: "toolCall", name: "agent_task", id: "start-1", arguments: { action: "start", prompt: "task" } };
	const waiting: ToolCall = { type: "toolCall", name: "wait_agent", id: "wait-1", arguments: { agent_id: "another-task" } };
	appendEntry(parent, { type: "message", message: batch([create, waiting]) });
	const end = deferred<string>();
	const f = fixture(parent, async () => end.promise);
	const created = await f.start("task", create.id);
	const id = created.agent_id;
	const childPath = join(dirname(parent.path), parent.header.id, "subagents", `agent-${id}.jsonl`);
	assert(existsSync(childPath));
	assert.throws(() => fixture(parent, async () => "must not run"), /active session/);
	end.resolve("");
	await f.manager.close();

	// Simulate a killed process immediately after the command's side effect.
	const command = batch([{ type: "toolCall", name: "write", id: "effect", arguments: {} }]);
	const rows = [{ type: "subagent_state", status: "running" },
		{ type: "compaction", summary: "retained summary", keptMessages: [] },
		{ type: "message", message: command }];
	appendFileSync(childPath, rows.map(row => JSON.stringify(row)).join("\n") + '\n{"type":"message"');
	appendFileSync(parent.path, '{"type":"message"');
	const restored = fixture(parent, async run => {
		assert.deepEqual(run.messages.map(m => m.role), ["user", "assistant", "toolResult"]);
		assert.match(JSON.stringify(run.messages[0]), /retained summary/);
		assert.match(JSON.stringify(run.messages.at(-1)), /outcome unknown/i);
		return "reconciled";
	});
	try {
		const messages = loadSession(parent.path).messages;
		restored.manager.recoverParent(messages);
		restored.manager.recoverParent(messages);
		assert.deepEqual(messages.slice(1).map(m => m.role === "toolResult" && [m.toolCallId, m.details]), [
			[create.id, { agent_id: id, status: "paused" }], [waiting.id, { agent_id: "another-task", status: "interrupted" }],
		]);
		assert.equal(loadSession(parent.path).messages.length, 3);
		assert.deepEqual(await restored.wait(id), { agent_id: id, status: "paused" });
		for (let i = 0; i < 2; i++) assert.equal((await restored.task("pause", { agent_id: id })).status, "paused");
		assert.equal((await restored.start("task", create.id)).agent_id, id);
		assert.deepEqual(await restored.task("resume", { agent_id: id }), created);
		assert.deepEqual(await restored.wait(id), { agent_id: id, status: "completed", report: "reconciled" });
		const toolResults = loadSession(childPath).messages.filter(m => m.role === "toolResult");
		assert.equal(toolResults.length, 1);
		assert.equal(toolResults[0].toolCallId, "effect");
		assert.equal(readdirSync(dirname(parent.path)).filter(n => n.endsWith(".jsonl")).length, 1);
	} finally { await restored.manager.close(); }

	const final = fixture(parent, async () => { throw new Error("unexpected dispatch"); });
	try {
		assert.equal((await final.wait(id)).report, "reconciled");
		assert.match(final.manager.catalog(), new RegExp(id));
		assert(!readFileSync(parent.path, "utf8").includes("reconciled"));
		assert.deepEqual(readSessionRows(childPath).at(-1), { type: "subagent_state", status: "completed", report: "reconciled" });
	} finally { await final.manager.close(); }
});

test("failed tasks remain inspectable, arguments and foreign IDs are rejected, and closing seals dispatch", async t => {
	const root = tempWorkspace(t);
	const f = fixture(createSessionFile(root, root), async () => { throw new Error("scripted failure"); });
	const peer = fixture(createSessionFile(root, root), async () => "unexpected");
	try {
		const { agent_id } = await f.start("error path");
		assert.deepEqual(await f.wait(agent_id), { agent_id, status: "failed", error: "scripted failure" });
		assert.equal((await f.task("resume", { agent_id })).status, "failed");
		await assert.rejects(peer.wait(agent_id), /Unknown subagent/);
		await assert.rejects(peer.wait("../outside"), /Unknown subagent/);
		await assert.rejects(peer.task("pause", {}), /requires agent_id/);
		await assert.rejects(peer.task("start", { prompt: " " }), /requires a nonempty prompt/);
		await peer.manager.close();
		peer.manager.allowRuns();
		await assert.rejects(peer.start("late creation"), /stopping/);
	} finally { await Promise.all([f.manager.close(), peer.manager.close()]); }
});

test("a second idle manager indexes existing tasks when it first acquires the parent", async t => {
	const root = tempWorkspace(t);
	const parent = createSessionFile(root, root);
	const first = fixture(parent, async () => "first report");
	const second = fixture(parent, async () => { throw new Error("duplicate"); });
	try {
		const created = await first.start('line one\n"line two"');
		assert.equal((await first.wait(created.agent_id)).report, "first report");
		await assert.rejects(second.start("same call ID"), /active session/);
		await first.manager.close();
		const existing = await second.start("same call ID");
		assert.equal(existing.agent_id, created.agent_id);
		assert.equal(existing.status, "completed");
		assert.equal((await second.wait(created.agent_id)).report, "first report");
		assert.equal(second.manager.catalog().split("\n").length, 2);
		assert.match(second.manager.catalog(), /line one/);
	} finally { await Promise.all([first.manager.close(), second.manager.close()]); }
});

test("a live parent batch excludes recovery before its first task, and idle ordinary sessions release ownership", async t => {
	const root = tempWorkspace(t);
	const parent = createSessionFile(root, root);
	const first = fixture(parent, async () => "");
	const second = fixture(parent, async () => "");
	const call = { type: "toolCall" as const, id: "ordinary", name: "write", arguments: {} };
	try {
		first.manager.claimForToolBatch();
		appendEntry(parent, { type: "message", message: batch([call]) });
		const staleMessages = loadSession(parent.path).messages;
		await assert.rejects(second.start("race during tool batch"), /active session/);
		assert.throws(() => second.manager.recoverParent(staleMessages), /active session/);
		appendEntry(parent, { type: "message", message: {
			role: "toolResult", toolCallId: call.id, toolName: call.name, timestamp: 1, isError: false,
			content: [{ type: "text", text: "written" }],
		} });
		first.manager.releaseIdleClaim();
		second.manager.recoverParent(staleMessages);
		assert.deepEqual(staleMessages, loadSession(parent.path).messages);
		assert.equal(staleMessages.length, 2);
		assert.equal(staleMessages[1].content[0].type === "text" && staleMessages[1].content[0].text, "written");
		const third = fixture(parent, async () => "");
		try {
			first.manager.claimForToolBatch();
			assert.throws(() => third.manager.claimForToolBatch(), /active session/);
		} finally { await third.manager.close(); }
	} finally { await Promise.all([first.manager.close(), second.manager.close()]); }
});
