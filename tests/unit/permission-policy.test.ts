import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { PermissionPolicy } from "../../src/cli/permissions/permission-policy.ts";
import type { BeforeToolCallContext } from "../../src/types.ts";
import { deferred, tempWorkspace } from "../support/fixtures.ts";

function context(name: string, args: Record<string, unknown> = {}): BeforeToolCallContext {
	return { toolCall: { type: "toolCall", id: "call", name, arguments: args }, args,
		assistantMessage: { role: "assistant", content: [], model: "test", stopReason: "toolUse", timestamp: 0 },
		context: { systemPrompt: "", messages: [] } };
}

test("noninteractive default permits reads and blocks writes and commands", async (t) => {
	const policy = new PermissionPolicy(tempWorkspace(t), false);
	t.after(() => policy.dispose());
	assert.equal(await policy.beforeToolCall(context("read")), undefined);
	for (const name of ["write", "edit", "bash"]) {
		assert.equal((await policy.beforeToolCall(context(name)))?.block, true);
	}
	assert.equal(policy.getSnapshot().request, null);
});

test("auto-edit permits file changes but requires approval for commands; yolo permits both", async (t) => {
	const policy = new PermissionPolicy(tempWorkspace(t), false, "auto-edit");
	t.after(() => policy.dispose());
	for (const name of ["write", "edit"]) assert.equal(await policy.beforeToolCall(context(name)), undefined);
	assert.equal((await policy.beforeToolCall(context("bash")))?.block, true);
	policy.cycleMode();
	assert.equal(policy.getSnapshot().mode, "yolo");
	assert.equal(await policy.beforeToolCall(context("bash")), undefined);
	policy.cycleMode();
	assert.equal(policy.getSnapshot().mode, "default");
});

test("session command approval matches the exact command and resets for a new session", async (t) => {
	const policy = new PermissionPolicy(tempWorkspace(t), true);
	t.after(() => policy.dispose());
	const command = context("bash", { command: "echo one" });
	const first = policy.beforeToolCall(command);
	assert.ok(policy.getSnapshot().request);
	policy.decide("session");
	assert.equal(await first, undefined);
	assert.equal(await policy.beforeToolCall(command), undefined);
	const other = policy.beforeToolCall(context("bash", { command: "echo one && echo two" }));
	assert.ok(policy.getSnapshot().request);
	policy.decide("deny");
	assert.equal((await other)?.block, true);
	policy.resetSession();
	const reset = policy.beforeToolCall(command);
	assert.ok(policy.getSnapshot().request);
	policy.cancel();
	assert.equal((await reset)?.block, true);
});

test("cancelling a pending approval settles it and clears the request", async (t) => {
	const policy = new PermissionPolicy(tempWorkspace(t), true);
	t.after(() => policy.dispose());
	const controller = new AbortController();
	const pending = policy.beforeToolCall(context("bash", { command: "echo pending" }), controller.signal);
	controller.abort();
	assert.equal((await pending)?.block, true);
	assert.equal(policy.getSnapshot().request, null);
	assert.equal((await policy.beforeToolCall(context("read"), controller.signal))?.block, true);
});

test("write approval exposes a real diff and user rejection feedback", async (t) => {
	const root = tempWorkspace(t);
	writeFileSync(join(root, "a.txt"), "before\n");
	const policy = new PermissionPolicy(root, true);
	t.after(() => policy.dispose());
	const ready = deferred();
	policy.subscribe(() => { if (policy.getSnapshot().request) ready.resolve(); });
	const pending = policy.beforeToolCall(context("write", { path: "a.txt", content: "after\n" }));
	await ready.promise;
	assert.ok(policy.getSnapshot().request?.hunks?.length);
	policy.feedback.replaceText("please preserve the original");
	policy.decide("deny");
	assert.deepEqual(await pending, { block: true, reason: "please preserve the original" });
});

test("disposal releases an outstanding permission request", async (t) => {
	const policy = new PermissionPolicy(tempWorkspace(t), true);
	const pending = policy.beforeToolCall(context("bash", { command: "echo no" }));
	policy.dispose();
	assert.equal((await pending)?.block, true);
});
