import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate as tick } from "node:timers/promises";
import { ToolCallScheduler, type ToolAccess } from "../../src/agent/tool-scheduler.ts";
import { deferred } from "../support/fixtures.ts";

function file(path: string, mode: "read" | "write"): ToolAccess {
	return [{ path, mode }];
}

async function unexpectedSkip(): Promise<never> {
	throw new Error("unexpected skip");
}

test("independent files start before a write's approval or the end of the model stream", async () => {
	const batch = new ToolCallScheduler<string>();
	const approval = deferred();
	const started: string[] = [];
	batch.add(file("c", "write"), async () => {
		started.push("edit c");
		await approval.promise;
		return "wrote c";
	}, unexpectedSkip);
	await tick();
	assert.deepEqual(started, ["edit c"]);
	batch.add(file("c", "read"), async () => { started.push("read c"); return "new c"; }, unexpectedSkip);
	batch.add(file("b", "read"), async () => { started.push("read b"); return "b"; }, unexpectedSkip);
	await tick();
	assert.deepEqual(started, ["edit c", "read b"]);

	approval.resolve();
	assert.deepEqual(await batch.finish(), ["wrote c", "new c", "b"]);
	assert.deepEqual(started, ["edit c", "read b", "read c"]);
});

test("all earlier readers finish before a writer and a queued writer blocks later readers", async () => {
	const batch = new ToolCallScheduler<number>();
	const gates = [deferred(), deferred(), deferred()];
	const started: number[] = [];
	const accesses: ToolAccess[] = [
		file("a", "read"), file("a", "read"), [{ path: "a", mode: "write" }, { path: "b", mode: "write" }], file("b", "read"),
	];
	for (const [index, access] of accesses.entries()) {
		batch.add(access, async () => {
			started.push(index);
			await gates[index]?.promise;
			return index;
		}, unexpectedSkip);
	}
	const results = batch.finish();
	await tick();
	assert.deepEqual(started, [0, 1]);
	gates[1].resolve();
	await tick();
	assert.deepEqual(started, [0, 1]);
	gates[0].resolve();
	await tick();
	assert.deepEqual(started, [0, 1, 2]);
	gates[2].resolve();
	assert.deepEqual(await results, [0, 1, 2, 3]);
	assert.deepEqual(started, [0, 1, 2, 3]);
});

test("a pending classification and an exclusive tool preserve their position in the stream", async () => {
	const batch = new ToolCallScheduler<number>();
	const access = deferred<ToolAccess>();
	const releaseFirst = deferred();
	const releaseExclusive = deferred();
	const started: number[] = [];
	batch.add(access.promise, async () => { started.push(1); await releaseFirst.promise; return 1; }, unexpectedSkip);
	batch.add(Promise.reject(new Error("unavailable resource")), async () => {
		started.push(2);
		await releaseExclusive.promise;
		return 2;
	}, unexpectedSkip);
	batch.add(file("b", "read"), async () => { started.push(3); return 3; }, unexpectedSkip);
	await tick();
	assert.deepEqual(started, []);
	access.resolve(file("a", "read"));
	await tick();
	assert.deepEqual(started, [1]);
	releaseFirst.resolve();
	await tick();
	assert.deepEqual(started, [1, 2]);
	releaseExclusive.resolve();
	assert.deepEqual(await batch.finish(), [1, 2, 3]);
});

test("abort skips queued and unclassified work and finish drains the running callback", async () => {
	const controller = new AbortController();
	const batch = new ToolCallScheduler<string>(controller.signal);
	const release = deferred();
	const skipped: string[] = [];
	const queue = (id: string, access: ToolAccess | PromiseLike<ToolAccess>) => batch.add(access,
		async () => { throw new Error("unexpected execution: " + id); },
		async () => { skipped.push(id); return id; });
	batch.add("exclusive", async () => { await release.promise; return "ran"; }, unexpectedSkip);
	await tick();
	queue("waiting", file("b", "read"));
	queue("classifying", new Promise<ToolAccess>(() => {}));
	controller.abort();
	queue("late", []);
	let finished = false;
	const results = batch.finish().then(values => { finished = true; return values; });
	await tick();
	assert.deepEqual(skipped, ["waiting", "classifying", "late"]);
	assert.equal(finished, false);
	release.resolve();
	assert.deepEqual(await results, ["ran", "waiting", "classifying", "late"]);
});

test("an unexpected callback failure still drains sibling executions", async () => {
	const batch = new ToolCallScheduler<void>();
	const release = deferred();
	const failure = new Error("listener failed");
	const completed: string[] = [];
	batch.add([], async () => { throw failure; }, unexpectedSkip);
	batch.add([], async () => { await release.promise; completed.push("finished"); }, unexpectedSkip);
	await tick(); // The rejection is handled even before finish attaches.
	let finished = false;
	const result = assert.rejects(batch.finish(), error => error === failure).then(() => { finished = true; });
	await tick();
	assert.equal(finished, false);
	release.resolve();
	await result;
	assert.deepEqual(completed, ["finished"]);
});

test("execution slots run four tools, grant the next free slot in FIFO order and cancel waiting tools", async () => {
	const controller = new AbortController();
	const batch = new ToolCallScheduler<number>(controller.signal);
	const gates = Array.from({ length: 7 }, () => deferred());
	const started: number[] = [];
	const cancelled: number[] = [];
	for (const [id, gate] of gates.entries()) {
		batch.add([], async () => {
			try {
				return await batch.withExecutionSlot(async () => { started.push(id); await gate.promise; return id; });
			} catch (error) {
				assert.equal(error, controller.signal.reason);
				cancelled.push(id);
				return id;
			}
		}, unexpectedSkip);
	}
	await tick();
	assert.deepEqual(started, [0, 1, 2, 3]);
	gates[2].resolve();
	await tick();
	assert.deepEqual(started, [0, 1, 2, 3, 4]);
	controller.abort();
	await tick();
	assert.deepEqual(cancelled, [5, 6]);
	for (const gate of gates) gate.resolve();
	assert.deepEqual(await batch.finish(), [0, 1, 2, 3, 4, 5, 6]);
	assert.deepEqual(started, [0, 1, 2, 3, 4]);
});
