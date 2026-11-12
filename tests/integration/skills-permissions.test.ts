import assert from "node:assert/strict";
import test from "node:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ReplController } from "../../src/cli/repl/repl-controller.ts";
import { createPromptDraft } from "../../src/cli/input/prompt-draft.ts";
import { createTestHarness, messageText } from "../support/harness.ts";
import { writeSkill } from "../support/skills.ts";
import { waitFor } from "../support/fixtures.ts";
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
