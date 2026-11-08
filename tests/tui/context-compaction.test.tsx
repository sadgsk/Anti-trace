import assert from "node:assert/strict";
import test from "node:test";
import { PassThrough } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import { startTerminalRepl } from "../../src/cli/repl/terminal-repl.tsx";
import { createPromptDraft } from "../../src/cli/input/prompt-draft.ts";
import type { TerminalStreams } from "../../src/cli/ink/terminal-host.ts";
import { createTestHarness } from "../support/harness.ts";
import { seedCompactionHistory } from "../support/compaction.ts";
import { deferred, waitFor } from "../support/fixtures.ts";
import type { ResponseStep } from "../support/scripted-model.ts";

class Input extends PassThrough { isTTY = true; isRaw = false; setRawMode(value: boolean) { this.isRaw = value; return this; } }
class Output extends PassThrough { isTTY = true; columns = 110; rows = 32; }

for (const mode of ["preflight", "recovery"] as const) test(`real TUI: ${mode} shows compaction progress and completion before the task finishes`, async (t) => {
	const summaryEntered = deferred(), releaseSummary = deferred(), continuationEntered = deferred(), releaseContinuation = deferred();
	const steps: ResponseStep[] = [{ text: "old answer" }];
	if (mode === "recovery") steps.push({ error: "Your input exceeds the context window" });
	steps.push(async () => { summaryEntered.resolve(); await releaseSummary.promise; return { text: "<summary>History compacted; continue current task.</summary>" }; },
		async () => { continuationEntered.resolve(); await releaseContinuation.promise; return { text: "final answer", usage: { input: 1200, output: 5 } }; });
	const { harness, root, events, scripted } = createTestHarness(t, steps);
	await seedCompactionHistory(harness);
	if (mode === "preflight") harness.setContextWindow(40000);
	events.length = 0;
	const stdin = new Input(), stdout = new Output();
	let output = ""; stdout.on("data", chunk => { output += chunk.toString(); });
	const app = startTerminalRepl({ harness, cwd: root, streams: { stdin, stdout } as unknown as TerminalStreams });
	const pending = app.repl.submit(createPromptDraft("current task"));
	try {
		await summaryEntered.promise;
		await waitFor(() => stripVTControlCharacters(output).includes("压缩上下文中"), "visible compaction spinner");
		assert.equal(app.repl.getSnapshot().busy, true);
		assert.equal(app.repl.getSnapshot().error, undefined);
		assert.equal(events.filter(event => event.type === "prompt_end").length, 0);
		assert.doesNotMatch(stripVTControlCharacters(output), /exceeds the context window/);

		releaseSummary.resolve();
		await continuationEntered.promise;
		await waitFor(() => stripVTControlCharacters(output).includes("会话已压缩"), "visible compaction result before final reply");
		const during = app.repl.getSnapshot();
		const compact = during.activeItems.find(item => item.kind === "compact");
		assert.ok(compact && compact.kind === "compact");
		assert.ok(compact.before > compact.after);
		assert.match(compact.summary, /History compacted/);
		assert.equal(during.phase, "thinking");
		assert.equal(during.busy, true);
		assert.equal(during.error, undefined);
		assert.equal(events.filter(event => event.type === "prompt_end").length, 0);

		releaseContinuation.resolve();
		await pending;
		await waitFor(() => stripVTControlCharacters(output).includes("final answer"), "final reply");
		assert.equal(app.repl.getSnapshot().error, undefined);
		assert.equal(app.repl.getSnapshot().busy, false);
		assert.equal(app.repl.getSnapshot().transcript.filter(item => item.kind === "notice" && item.tone === "error").length, 0);
		assert.deepEqual(events.filter(event => event.type === "prompt_end").map(event => event.result), [{ status: "success" }]);
		assert.doesNotMatch(stripVTControlCharacters(output), /exceeds the context window/);
		if (mode === "recovery") {
			await app.repl.submit(createPromptDraft("/resume"));
			assert.equal(app.repl.dialogs.getSnapshot()?.kind, "picker");
			app.repl.dialogs.target.actions!["dialog:accept"]!({ type: "key", name: "enter" } as any);
			assert.equal(app.repl.dialogs.getSnapshot(), null);
			assert.equal(app.repl.getSnapshot().transcript.filter(item => item.kind === "notice" && item.tone === "error").length, 0);
		}
		harness.setContextWindow(128000);
		scripted.appendResponses({ text: "followup succeeds" });
		await app.repl.submit(createPromptDraft("followup"));
		assert.equal(app.repl.getSnapshot().error, undefined);
	} finally {
		releaseSummary.resolve(); releaseContinuation.resolve();
		await pending;
		app.stop(); await app.done;
		stdin.destroy(); stdout.destroy();
	}
});

test("real TUI: cancellation during summary shows one interruption, clears busy, and accepts another task", async (t) => {
	const entered = deferred(), release = deferred();
	const { harness, root, events, scripted } = createTestHarness(t, [{ text: "old answer" },
		async () => { entered.resolve(); await release.promise; return { text: "<summary>late result</summary>" }; }]);
	await seedCompactionHistory(harness); harness.setContextWindow(40000); events.length = 0;
	const stdin = new Input(), stdout = new Output(); stdout.resume();
	const app = startTerminalRepl({ harness, cwd: root, streams: { stdin, stdout } as unknown as TerminalStreams });
	const pending = app.repl.submit(createPromptDraft("cancel this"));
	try {
		await entered.promise;
		app.repl.interrupt(); release.resolve();
		await pending;
		const state = app.repl.getSnapshot();
		assert.equal(state.busy, false);
		assert.equal(state.transcript.filter(item => item.kind === "notice" && item.text.includes("已中断")).length, 1);
		assert.equal(state.transcript.some(item => item.kind === "compact"), false);
		assert.equal(events.filter(event => event.type === "prompt_end" && event.result.status === "aborted").length, 1);
		harness.setContextWindow(128000); scripted.appendResponses({ text: "next succeeds" });
		await app.repl.submit(createPromptDraft("next"));
		assert.equal(app.repl.getSnapshot().error, undefined);
		assert.equal(app.repl.getSnapshot().busy, false);
	} finally { release.resolve(); await pending; app.stop(); await app.done; stdin.destroy(); stdout.destroy(); }
});

test("real TUI: a thrown recovery error is displayed once and retains its actual cause", async (t) => {
	const { harness, root } = createTestHarness(t, [{ text: "old answer" }, { error: "maximum context length exceeded" }, { error: "summary service refused this request" }]);
	await seedCompactionHistory(harness);
	const stdin = new Input(), stdout = new Output();
	let output = ""; stdout.on("data", chunk => { output += chunk.toString(); });
	const app = startTerminalRepl({ harness, cwd: root, streams: { stdin, stdout } as unknown as TerminalStreams });
	try {
		await app.repl.submit(createPromptDraft("current task"));
		await waitFor(() => stripVTControlCharacters(output).includes("summary service refused this request"), "final error frame");
		const state = app.repl.getSnapshot();
		assert.match(state.error ?? "", /summary service refused this request/);
		assert.equal(state.transcript.filter(item => item.kind === "notice" && item.tone === "error").length, 1);
		assert.doesNotMatch(stripVTControlCharacters(output), /maximum context length exceeded/);
		assert.equal(state.busy, false);
	} finally { app.stop(); await app.done; stdin.destroy(); stdout.destroy(); }
});
