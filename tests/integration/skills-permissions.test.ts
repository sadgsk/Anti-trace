import assert from "node:assert/strict";
import test from "node:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ReplController } from "../../src/cli/repl/repl-controller.ts";
import { Harness } from "../../src/harness/harness.ts";
import { createPromptDraft } from "../../src/cli/input/prompt-draft.ts";
import { createTestHarness, messageText, testModel } from "../support/harness.ts";
import { createScriptedModel } from "../support/scripted-model.ts";
import { writeSkill } from "../support/skills.ts";
import { tempWorkspace, waitFor } from "../support/fixtures.ts";
import { assertToolPairs } from "../support/compaction.ts";

test("plain instruction loading works under the default noninteractive permission policy", async t => {
	const f = createTestHarness(t, [{ toolCalls: [{ id: "skill", name: "skill", arguments: { skill: "review" } }] }, { text: "loaded" }]);
	writeSkill(f.root);
	const repl = new ReplController({ harness: f.harness, cwd: f.root }); t.after(() => repl.dispose());
	await repl.submit(createPromptDraft("review"));
	assert.equal(f.agent.state.messages.find(message => message.role === "toolResult")?.isError, false);
	assert.equal(messageText(f.agent.state.messages.at(-1)), "loaded");
});

test("skill grants require approval, work for the invoking turn, and clear on the next user input", async t => {
	const f = createTestHarness(t, [
		{ toolCalls: [{ id: "load", name: "skill", arguments: { skill: "review" } }] },
		{ toolCalls: [{ id: "write-one", name: "write", arguments: { path: "one.txt", content: "one" } }] }, { text: "one done" },
		{ toolCalls: [{ id: "write-two", name: "write", arguments: { path: "two.txt", content: "two" } }] }, { text: "denied" },
	]);
	writeSkill(f.root, "review", "write one", { "allowed-tools": ["write"] });
	const repl = new ReplController({ harness: f.harness, cwd: f.root, interactive: true }); t.after(() => repl.dispose());
	const first = repl.submit(createPromptDraft("review"));
	await waitFor(() => repl.permissions.getSnapshot().request?.name === "skill", "skill permission");
	assert.deepEqual(repl.permissions.getSnapshot().request?.args.allowedTools, ["write"]);
	repl.permissions.decide("allow"); await first;
	assert.equal(existsSync(join(f.root, "one.txt")), true);
	const second = repl.submit(createPromptDraft("write another"));
	await waitFor(() => repl.permissions.getSnapshot().request?.name === "write", "fresh write permission");
	repl.permissions.decide("deny"); await second;
	assert.equal(existsSync(join(f.root, "two.txt")), false);
	assert.deepEqual(f.harness.getActiveSkillTools(), []);
});

test("denied skill activation has no instruction snapshot or tool grants", async t => {
	const f = createTestHarness(t, [{ toolCalls: [{ id: "load", name: "skill", arguments: { skill: "review" } }] }, { text: "permission denied" }]);
	writeSkill(f.root, "review", "grant write", { "allowed-tools": ["write"] });
	const repl = new ReplController({ harness: f.harness, cwd: f.root }); t.after(() => repl.dispose());
	await repl.submit(createPromptDraft("review"));
	assert.equal(f.agent.state.messages.some(message => message.role === "user" && message.metadata?.kind === "skill"), false);
	assert.deepEqual(f.harness.getActiveSkillTools(), []);
	assert.ok(f.agent.state.messages.some(message => message.role === "toolResult" && message.isError));
});

test("steering clears a skill grant after the active batch and before the next request", async t => {
	const write = (id: string) => ({ id, name: "write", arguments: { path: id, content: id } });
	const f = createTestHarness(t, [
		{ toolCalls: [write("first"), write("second")] }, { toolCalls: [write("after-steer")] }, { text: "done" },
	]);
	writeSkill(f.root, "review", "update two files", { "allowed-tools": ["write"] });
	const repl = new ReplController({ harness: f.harness, cwd: f.root });
	t.after(() => repl.dispose());
	f.harness.subscribe(event => {
		if (event.type === "tool_execution_start" && event.toolCallId === "first") assert.ok(f.harness.steer("new request"));
	});
	await f.harness.invokeSkill("review");
	assert.equal(messageText(f.scripted.requests[1]!.context.messages.at(-1)), "new request");
	assert.deepEqual(f.harness.getActiveSkillTools(), []);
	assert.ok(existsSync(join(f.root, "first")) && existsSync(join(f.root, "second")));
	const last = f.scripted.requests[2]!.context.messages.at(-1);
	assert.ok(last?.role === "toolResult" && last.isError);
	assert.equal(existsSync(join(f.root, "after-steer")), false);
});

test("abort after tool completion preserves call/result pairs and discards uncommitted instructions", async t => {
	const f = createTestHarness(t, [{ toolCalls: [{ id: "load", name: "skill", arguments: { skill: "review" } }, { id: "read", name: "read", arguments: { path: "missing" } }] }]);
	writeSkill(f.root);
	const unsubscribe = f.harness.subscribe(event => { if (event.type === "tool_execution_end" && event.toolName === "skill") f.harness.abort(); });
	t.after(unsubscribe);
	await f.harness.prompt("review");
	assertToolPairs(f.agent.state.messages);
	assert.equal(f.agent.state.messages.some(message => message.role === "user" && message.metadata?.kind === "skill"), false);
	assert.deepEqual(f.harness.getActiveSkillTools(), []);
});

test("provider failure after activation clears turn-scoped grants", async t => {
	const f = createTestHarness(t, [{ error: "provider unavailable" }]);
	writeSkill(f.root, "review", "instructions", { "allowed-tools": ["write"] });
	await f.harness.invokeSkill("review");
	assert.deepEqual(f.harness.getActiveSkillTools(), []);
	assert.equal(f.agent.state.messages.at(-1)?.role, "assistant");
});

test("a delegated agent must activate its own skill before using its granted tools", { timeout: 15000 }, async t => {
	const root = tempWorkspace(t);
	writeSkill(root, "review", "write one", { "allowed-tools": ["write"] });
	const write = (path: string) => ({ toolCalls: [{ id: path, name: "write", arguments: { path, content: "ok" } }] });
	const child = createScriptedModel([
		write("denied"), { toolCalls: [{ id: "load", name: "skill", arguments: { skill: "review" } }] },
		write("approved"), { text: "child done" },
	]);
	let agentId = "";
	const parent = createScriptedModel([
		{ toolCalls: [{ id: "delegate", name: "agent_task", arguments: { action: "start", prompt: "child review" } }] },
		req => {
			agentId = JSON.parse(messageText(req.context.messages.at(-1))).agent_id;
			return { toolCalls: [{ id: "wait", name: "wait_agent", arguments: { agent_id: agentId } }] };
		}, { text: "parent done" },
	]);
	const harness = new Harness({ cwd: root, model: testModel, apiKey: "test", sessionsRoot: join(root, "sessions"),
		streamFn: (model, ctx, options) => (ctx.tools?.some(tool => tool.name === "agent_task") ? parent : child).streamFn(model, ctx, options) });
	const repl = new ReplController({ harness, cwd: root, interactive: true });
	try {
		const run = harness.invokeSkill("review");
		await waitFor(() => repl.permissions.getSnapshot().request?.name === "write" && Boolean(agentId), "child approval");
		assert.deepEqual(harness.getActiveSkillTools(), ["write"]);
		assert.deepEqual(repl.permissions.getSnapshot().request?.agentSource, { agent_id: agentId, summary: "child review" });
		repl.permissions.decide("deny");
		await waitFor(() => repl.permissions.getSnapshot().request?.name === "skill", "child skill approval");
		assert.deepEqual(repl.permissions.getSnapshot().request?.args.allowedTools, ["write"]);
		repl.permissions.decide("allow");
		await run;
		assert.equal(existsSync(join(root, "denied")), false);
		assert.equal(existsSync(join(root, "approved")), true);
	} finally {
		await repl.dispose();
		await harness.close();
	}
});
