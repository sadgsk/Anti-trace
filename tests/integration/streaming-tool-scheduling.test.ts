import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { Type } from "typebox";
import { PermissionPolicy } from "../../src/cli/permissions/permission-policy.ts";
import { Harness, type HarnessEvent } from "../../src/harness/harness.ts";
import { loadSession } from "../../src/harness/session.ts";
import { streamModel } from "../../src/llm/adapter.ts";
import type { AgentMessage, Model } from "../../src/types.ts";
import { deferred, tempWorkspace, waitFor } from "../support/fixtures.ts";
import { messageText, testModel } from "../support/harness.ts";
import { createHttpFixture } from "../support/http-server.ts";
import { nativeResponse } from "../support/native-response.ts";

type Call = { id: string; name: string; args: Record<string, unknown> };

/** Send complete tool blocks and leave the HTTP response open until the test releases it. */
async function streamingFixture(t: TestContext, calls: Call[], adapter?: Model["adapter"]) {
	const terminal = deferred<string>();
	const root = tempWorkspace(t, async () => { terminal.resolve(""); await harness.close(); });
	const api = "anthropic-messages";
	const wire = nativeResponse(api, calls, "");
	const cut = wire.indexOf("event: message_delta");
	assert.ok(cut > 0);
	const http = await createHttpFixture(t, async (_request, response, index) => {
		response.writeHead(200, { "content-type": "text/event-stream" });
		if (index !== 0) {
			response.end(nativeResponse(api, [], "finished"));
			return;
		}
		response.write(wire.slice(0, cut));
		response.end(await terminal.promise);
	});
	const harness = new Harness({ cwd: root, appHome: join(root, "app"), model: { ...testModel, api, baseUrl: http.url, adapter },
		apiKey: "local", streamFn: streamModel });
	const events: HarnessEvent[] = [];
	harness.subscribe(event => { events.push(event); });
	const ended = (id: string) => events.some(event => event.type === "tool_execution_end" && event.toolCallId === id);
	const statuses = () => events.flatMap(event => event.type === "prompt_end" ? [event.result.status] : []);
	const finishStream = (tail = wire.slice(cut)) => terminal.resolve(tail);
	return { root, harness, http, finishStream, events, ended, statuses };
}

function committedResults(harness: Harness) {
	const file = harness.listSessions()[0]!.filePath;
	return readFileSync(file, "utf8").trim().split("\n").flatMap(line => {
		const row = JSON.parse(line) as { type: string; message?: AgentMessage };
		return row.type === "message" && row.message?.role === "toolResult" ? [row.message] : [];
	});
}

test("an open response can approve an edit and run unrelated reads while preserving model and JSONL order", async t => {
	const calls = [
		{ id: "edit-c", name: "edit", args: { path: "c.txt", edits: [{ oldText: "before", newText: "after" }] } },
		{ id: "read-c", name: "read", args: { path: "./c.txt" } },
		{ id: "read-b", name: "read", args: { path: "b.txt" } },
	];
	const f = await streamingFixture(t, calls);
	writeFileSync(join(f.root, "c.txt"), "before");
	writeFileSync(join(f.root, "b.txt"), "independent");
	const policy = new PermissionPolicy(f.root, true);
	f.harness.setBeforeToolCall(policy.beforeToolCall);
	const run = f.harness.prompt("edit and read");
	try {
		await waitFor(() => policy.getSnapshot().request?.id === "edit-c" && f.ended("read-b"), "edit approval and unrelated read");
		assert.equal(readFileSync(join(f.root, "c.txt"), "utf8"), "before");
		assert.ok(!f.events.some(event => event.type === "tool_execution_start" && event.toolCallId === "read-c"));
		assert.ok(f.harness.steer("check-again-after-tools"));
		policy.decide("allow");
		await waitFor(() => f.ended("read-c"), "post-edit read in the open stream");
		assert.equal(readFileSync(join(f.root, "c.txt"), "utf8"), "after");
		assert.equal(f.http.requests.length, 1);
		const journal = loadSession(f.harness.listSessions()[0]!.filePath);
		const ids = calls.map(call => call.id);
		assert.deepEqual(journal.interruptedAssistant?.content.flatMap(block => block.type === "toolCall" ? [block.id] : []), ids);
		assert.equal(journal.uncommittedToolResults?.get("edit-c")?.isError, false);
		f.finishStream();
		await run;
		assert.deepEqual(f.statuses(), ["success"]);
		const recorded = committedResults(f.harness);
		assert.deepEqual(recorded.map(result => result.toolCallId), ids);
		assert.match(messageText(recorded[1]), /after/);
		const body = f.http.requests[1]!.body as { messages: { content: { tool_use_id?: string; text?: string }[] }[] };
		const blocks = body.messages.flatMap(message => message.content);
		assert.deepEqual(blocks.flatMap(block => block.tool_use_id ?? []), ids);
		assert.ok(blocks.findIndex(b => b.text === "check-again-after-tools") > blocks.findIndex(b => b.tool_use_id === "read-b"));
	} finally {
		policy.dispose();
		f.finishStream("");
		await run;
	}
});

test("a broken tool stream preserves an early write, cancels pending work behind an exclusive tool and permits the next request", async t => {
	const calls = [
		{ id: "wrote", name: "write", args: { path: "kept.txt", content: "first write" } },
		{ id: "barrier", name: "external", args: {} },
		{ id: "queued", name: "write", args: { path: "skip.txt", content: "never written" } },
	];
	const f = await streamingFixture(t, calls, { reasoningReplay: "required", thinkingSignature: "required" });
	let active = false;
	f.harness.agent.state.tools = [...f.harness.agent.state.tools, {
		name: "external", label: "external", description: "Unclassified external tool", parameters: Type.Object({}),
		async execute(_id, _args, signal) {
			active = true;
			await new Promise<void>(resolve => signal!.addEventListener("abort", () => resolve(), { once: true }));
			throw new Error("external request cancelled");
		},
	}];
	const run = f.harness.prompt("run three tools");
	try {
		await waitFor(() => active && f.ended("wrote"), "external tool after the committed write");
		assert.ok(!f.events.some(event => event.type === "tool_execution_start" && event.toolCallId === "queued"));
		f.finishStream(""); // End the HTTP body without a provider terminal event.
		await run;
		assert.deepEqual(f.statuses(), ["error"]);
		const results = committedResults(f.harness);
		assert.deepEqual(results.map(result => [result.toolCallId, result.isError]), [
			["wrote", false], ["barrier", true], ["queued", true],
		]);
		assert.equal(readFileSync(join(f.root, "kept.txt"), "utf8"), "first write");
		assert.equal(existsSync(join(f.root, "skip.txt")), false);
		writeFileSync(join(f.root, "kept.txt"), "modified after interruption");
		await f.harness.prompt("continue without replaying tools");
		assert.deepEqual(f.statuses(), ["error", "success"]);
		assert.equal(f.http.requests.length, 2);
		const continuation = JSON.stringify(f.http.requests[1]!.body);
		assert.match(continuation, /wrote \(success\)/);
		assert.match(continuation, /queued \(error\)/);
		assert.equal(f.events.filter(event => event.type === "tool_execution_start" && event.toolCallId === "wrote").length, 1);
		assert.equal(readFileSync(join(f.root, "kept.txt"), "utf8"), "modified after interruption");
		assert.equal(existsSync(join(f.root, "skip.txt")), false);
	} finally {
		f.finishStream("");
		await run;
	}
});

test("max_tokens after an early write pairs a later truncated tool block without running or retrying it", async t => {
	const f = await streamingFixture(t, [
		{ id: "complete", name: "write", args: { path: "kept.txt", content: "written once" } },
	]);
	const prepared: string[] = [];
	f.harness.setBeforeToolCall(async ({ toolCall }) => { prepared.push(toolCall.id); return undefined; });
	const run = f.harness.prompt("perform both writes");
	try {
		await waitFor(() => f.ended("complete"), "first write before max_tokens");
		const tail = [
			{ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "truncated", name: "write", input: {} } },
			{ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"path":"missing.txt","content":' } },
			{ type: "content_block_stop", index: 1 },
			{ type: "message_delta", delta: { stop_reason: "max_tokens" }, usage: { output_tokens: 32 } },
			{ type: "message_stop" },
		];
		f.finishStream(tail.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""));
		await run;
		assert.equal(f.http.requests.length, 1);
		assert.deepEqual(f.statuses(), ["error"]);
		const assistant = f.harness.agent.state.messages.find(message => message.role === "assistant");
		assert.equal(assistant?.stopReason, "length");
		assert.deepEqual(assistant?.content.flatMap(block => block.type === "toolCall" ? [block.id] : []), ["complete", "truncated"]);
		assert.deepEqual(prepared, ["complete"]);
		const results = committedResults(f.harness);
		assert.deepEqual(results.map(result => [result.toolCallId, result.isError]), [["complete", false], ["truncated", true]]);
		assert.match(messageText(results[1]), /output token limit/);
		assert.equal(readFileSync(join(f.root, "kept.txt"), "utf8"), "written once");
		assert.equal(existsSync(join(f.root, "missing.txt")), false);
		await f.harness.prompt("continue after truncation");
		assert.equal(f.http.requests.length, 2);
		assert.deepEqual(f.statuses(), ["error", "success"]);
		assert.deepEqual(prepared, ["complete"]);
	} finally {
		f.finishStream("");
		await run;
	}
});
