import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { Harness } from "../../src/harness/harness.ts";
import { streamModel } from "../../src/llm/adapter.ts";
import { deferred, tempWorkspace } from "../support/fixtures.ts";
import { createTestHarness, messageText, testModel } from "../support/harness.ts";
import { createHttpFixture } from "../support/http-server.ts";
import { nativeResponse } from "../support/native-response.ts";
import { createScriptedModel } from "../support/scripted-model.ts";

const first = "STEER_FIRST", second = "STEER_SECOND";
for (const api of ["openai-completions", "openai-responses", "anthropic-messages"] as const) {
	test(`${api} sends both paired tool results before queued user input`, { timeout: 15000 }, async t => {
		const root = tempWorkspace(t);
		writeFileSync(join(root, "file.txt"), "data");
		const calls = ["read-1", "read-2"].map(id => ({ id, name: "read", args: { path: "file.txt" } }));
		const http = await createHttpFixture(t, (_request, response, index) => {
			response.writeHead(200, { "content-type": "text/event-stream" }).end(nativeResponse(api, index ? [] : calls, "done"));
		});
		const harness = new Harness({ cwd: root, appHome: join(root, "app"), model: { ...testModel, api, baseUrl: http.url },
			apiKey: "local", streamFn: streamModel });
		const entered = [deferred(), deferred()], release = [deferred(), deferred()];
		harness.setBeforeToolCall(async ({ toolCall }) => {
			const index = calls.findIndex(call => call.id === toolCall.id);
			entered[index]!.resolve();
			await release[index]!.promise;
			return undefined;
		});
		const run = harness.prompt("read twice");
		try {
			await entered[0]!.promise;
			assert.ok(harness.steer(first));
			release[0]!.resolve();
			await entered[1]!.promise;
			assert.ok(harness.steer(second));
			assert.equal(http.requests.length, 1);
			release[1]!.resolve();
			await run;
			assert.equal(http.requests.length, 2);
			const body = http.requests[1]!.body as Record<string, any>;
			const items: Record<string, any>[] = api === "openai-responses" ? body.input
				: api === "anthropic-messages" ? body.messages.flatMap((msg: Record<string, any>) => msg.content) : body.messages;
			const ids = items.flatMap(item => item.tool_call_id ?? item.tool_use_id ?? (item.type === "function_call_output" ? item.call_id : []));
			assert.deepEqual(ids, ["read-1", "read-2"]);
			const ordered = items.map(item => item.tool_call_id ?? item.tool_use_id ?? (item.type === "function_call_output" ? item.call_id
				: JSON.stringify(item).includes(first) ? first : JSON.stringify(item).includes(second) ? second : ""));
			assert.deepEqual(ordered.filter(Boolean), ["read-1", "read-2", first, second]);
			const parent = readFileSync(harness.listSessions()[0]!.filePath, "utf8").trim().split("\n").map(line => JSON.parse(line))
				.filter(entry => entry.type === "message").map(entry => entry.message);
			assert.deepEqual(parent.slice(2, 6).map(msg => msg.role === "toolResult" ? msg.toolCallId : messageText(msg)), ["read-1", "read-2", first, second]);
		} finally {
			release.forEach(gate => gate.resolve());
			await harness.close();
			await run;
		}
	});
}

test("steering a final answer continues once and preserves a late handoff across a session reopen", async t => {
	const { harness, scripted, root, sessionsRoot } = createTestHarness(t, [{ text: "first answer" }, { text: "second answer" }]);
	let firstTurn = true, handoff = true;
	harness.subscribe(event => {
		if (firstTurn && event.type === "turn_end") { firstTurn = false; assert.ok(harness.steer("before final exit")); }
		if (handoff && event.type === "agent_end") { handoff = false; assert.ok(harness.steer("arrived at exit")); }
	});
	await harness.prompt("initial");
	assert.equal(scripted.requests.length, 2);
	assert.deepEqual(scripted.requests[1]!.context.messages.map(messageText), ["initial", "first answer", "before final exit"]);
	assert.equal(messageText(harness.getSessionMessages().at(-1)), "arrived at exit");
	await harness.close();
	const reopenedScript = createScriptedModel([{ text: "next answer" }]);
	const reopened = new Harness({ cwd: root, sessionsRoot, appHome: join(root, "app"), model: testModel, apiKey: "local", streamFn: reopenedScript.streamFn });
	t.after(() => reopened.close());
	assert.equal(await reopened.resumeAt(1), true);
	await reopened.prompt("next");
	assert.deepEqual(reopenedScript.requests[0]!.context.messages.map(messageText),
		["initial", "first answer", "before final exit", "second answer", "arrived at exit", "next"]);
});

for (const largeReply of [true, false]) {
	test(`automatic compaction preserves both pending steers when history ${largeReply ? "can" : "cannot"} shrink`, async t => {
		const { harness, scripted, events } = createTestHarness(t, [
			{ text: largeReply ? "old output ".repeat(1000) : "ok" }, { text: "<summary>Earlier task.</summary>" }, { text: "finished" },
		], { model: { ...testModel, contextWindow: 20000 } });
		const instructions = ["pause the review", "additional input ".repeat(1000)];
		let sent = false;
		harness.subscribe(event => {
			if (!sent && event.type === "turn_end") {
				sent = true;
				for (const text of instructions) assert.ok(harness.steer(text));
			}
		});
		await harness.prompt("original task");
		assert.equal(scripted.requests.length, 3);
		assert.ok(scripted.requests[1]!.context.messages.every(message => !instructions.includes(messageText(message))));
		assert.equal(events.some(event => event.type === "compaction_end"), largeReply);
		const actual = scripted.requests[2]!.context.messages.slice(-2);
		assert.deepEqual(actual.map(message => message.role), ["user", "user"]);
		assert.deepEqual(actual.map(messageText), instructions);
		assert.equal(messageText(harness.getSessionMessages().at(-1)), "finished");
	});
}

test("manual compaction after reopening preserves an unanswered steering handoff", async t => {
	const { harness, root, sessionsRoot } = createTestHarness(t, [{ text: "old answer ".repeat(3000) }]);
	const handoff = "instructions for next turn ".repeat(500);
	harness.subscribe(event => { if (event.type === "agent_end") assert.ok(harness.steer(handoff)); });
	await harness.prompt("earlier task");
	await harness.close();
	const script = createScriptedModel([{ text: "<summary>Earlier work.</summary>" }, { text: "done" }]);
	const reopened = new Harness({ cwd: root, appHome: join(root, "app"), sessionsRoot, model: { ...testModel, contextWindow: 20000 },
		apiKey: "local", streamFn: script.streamFn });
	try {
		assert.ok(await reopened.resumeAt(1));
		assert.ok(await reopened.compact());
		assert.equal(messageText(reopened.getSessionMessages().at(-1)), handoff);
		reopened.setContextWindow(testModel.contextWindow);
		await reopened.prompt("continue");
		assert.deepEqual(script.requests.at(-1)!.context.messages.slice(-2).map(messageText), [handoff, "continue"]);
	} finally { await reopened.close(); }
});

for (const status of ["aborted", "error"] as const) {
	test(`a parent ${status} exit persists accepted steering without a new request`, { timeout: 10000 }, async t => {
		const entered = deferred(), release = deferred();
		const { harness, scripted, events } = createTestHarness(t, [async () => {
			entered.resolve();
			await release.promise;
			return { error: "provider failed" };
		}]);
		const run = harness.prompt("work");
		try {
			await entered.promise;
			assert.ok(harness.steer("remember this"));
			if (status === "aborted") await harness.abort();
			release.resolve();
			await run;
			assert.equal(scripted.requests.length, 1);
			const last = events.at(-1);
			assert.ok(last?.type === "prompt_end" && last.result.status === status);
			assert.equal(events.filter(e => e.type === "message_end" && messageText(e.message) === "remember this").length, 1);
			const lines = readFileSync(harness.listSessions()[0]!.filePath, "utf8").trim().split("\n");
			assert.equal(lines.filter(line => line.includes("remember this")).length, 1);
			assert.equal(JSON.parse(lines.at(-1)!).message.role, "user");
		} finally { release.resolve(); await run; }
	});
}
