import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { PassThrough } from "node:stream";
import test from "node:test";
import { runCli } from "../../src/cli/main.ts";
import { createTestHarness, testModel } from "../support/harness.ts";
import { seedCompactionHistory } from "../support/compaction.ts";
import { tempWorkspace } from "../support/fixtures.ts";
import type { ResponseStep } from "../support/scripted-model.ts";

const overflow = { error: "Your input exceeds the context window" };
const summary = { text: "<summary>old work complete</summary>" };
const scenarios: Array<{ name: string; steps: ResponseStep[]; seed?: boolean; window?: number; error?: RegExp }> = [
	{ name: "ordinary success", steps: [{ text: "final answer" }] },
	{ name: "proactive compaction success", seed: true, window: 40000, steps: [summary, { text: "final answer" }] },
	{ name: "overflow error recovered", seed: true, steps: [overflow, summary, { text: "final answer" }] },
	{ name: "overflow length recovered", seed: true, steps: [{ stopReason: "length", usage: { input: testModel.contextWindow, output: 0 } }, summary, { text: "final answer" }] },
	{ name: "ordinary provider failure", steps: [{ error: "HTTP 401: invalid test credential" }], error: /HTTP 401: invalid test credential/ },
	{ name: "no compactable history", steps: [overflow], error: /exceeds the context window/ },
	{ name: "retry failed", seed: true, steps: [overflow, summary, { error: "HTTP 500: retry failed" }], error: /HTTP 500: retry failed/ },
	{ name: "retry overflow is bounded", seed: true, steps: [overflow, summary, { error: "maximum context length exceeded again" }], error: /maximum context length exceeded again/ },
	{ name: "recovery summary failed", seed: true, steps: [overflow, { error: "summary upstream unavailable" }], error: /summary upstream unavailable/ },
	{ name: "preflight summary failed", seed: true, window: 40000, steps: [{ error: "preflight upstream unavailable" }], error: /preflight upstream unavailable/ },
	{ name: "empty summary", seed: true, window: 40000, steps: [{ text: "" }], error: /summary was empty/ },
	{ name: "truncated summary", seed: true, window: 40000, steps: [{ text: "partial", stopReason: "length" }], error: /summary reached its output limit/ },
	{ name: "summary cannot shrink context", seed: true, window: 40000, steps: [{ text: "huge summary".repeat(15000) }], error: /did not reduce the context/ },
];

for (const scenario of scenarios) test(`real pipe: ${scenario.name} reports one final result with the correct exit code`, async (t) => {
	const steps: ResponseStep[] = scenario.seed ? [{ text: "old answer" }, ...scenario.steps] : scenario.steps;
	const { root, harness, events, scripted } = createTestHarness(t, steps);
	if (scenario.seed) await seedCompactionHistory(harness);
	if (scenario.window) harness.setContextWindow(scenario.window);
	events.length = 0;
	const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough();
	let output = "", errors = "";
	stdout.on("data", chunk => { output += chunk.toString(); });
	stderr.on("data", chunk => { errors += chunk.toString(); });
	try {
		stdin.end("current task");
		assert.equal(await runCli({ cwd: root, harness, streams: { stdin, stdout, stderr } }), scenario.error ? 1 : 0);
		const ends = events.filter(event => event.type === "prompt_end");
		assert.equal(ends.length, 1);
		assert.equal(ends[0]!.result.status, scenario.error ? "error" : "success");
		assert.equal(scripted.pendingResponses, 0);
		if (scenario.error) {
			assert.equal((output + errors).split("\n").filter(line => scenario.error!.test(line)).length, 1, "final error appears once, including thrown exceptions");
		} else {
			assert.match(output, /final answer/);
			assert.doesNotMatch(output + errors, /exceeds the context window|请求失败|上下文超限/);
		}
	} finally { stdin.destroy(); stdout.destroy(); stderr.destroy(); }
});

test("pre-Agent credential/configuration failure still produces one final event and one pipe error", async (t) => {
	const { harness, root, events, scripted } = createTestHarness(t, [], { unconfigured: true });
	const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough();
	let output = ""; stdout.on("data", chunk => { output += chunk.toString(); }); stderr.on("data", chunk => { output += chunk.toString(); });
	try {
		stdin.end("current task");
		assert.equal(await runCli({ cwd: root, harness, streams: { stdin, stdout, stderr } }), 1);
		assert.equal(output.split("\n").filter(line => line.includes("尚无可用模型配置")).length, 1);
		assert.equal(events.filter(event => event.type === "agent_end").length, 0);
		assert.equal(events.filter(event => event.type === "prompt_end" && event.result.status === "error").length, 1);
		assert.equal(scripted.requests.length, 0);
	} finally { stdin.destroy(); stdout.destroy(); stderr.destroy(); }
});

test("error deduplication does not hide a different exception after the final result was delivered", async (t) => {
	const { harness, root } = createTestHarness(t, [{ text: "final answer" }]);
	const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough();
	let output = ""; stdout.on("data", chunk => { output += chunk.toString(); }); stderr.on("data", chunk => { output += chunk.toString(); });
	const done = runCli({ cwd: root, harness, streams: { stdin, stdout, stderr } });
	// runCli has registered the controller; this subscriber runs after it.
	const unsubscribe = harness.subscribe(event => { if (event.type === "prompt_end") throw new Error("final subscriber failed"); });
	try {
		stdin.end("current task");
		assert.equal(await done, 1);
		assert.equal(output.split("\n").filter(line => line.includes("final subscriber failed")).length, 1);
	} finally { unsubscribe(); stdin.destroy(); stdout.destroy(); stderr.destroy(); }
});

for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]] as const) test(`pipe ${signal} preserves exit code ${code} during an outstanding model request`, async (t) => {
	const root = tempWorkspace(t);
	const child = spawn(process.execPath, ["--import", new URL("../../node_modules/tsx/dist/loader.mjs", import.meta.url).href,
		fileURLToPath(new URL("../support/context-signal-worker.ts", import.meta.url)), root, signal],
	{ env: process.env, stdio: ["ignore", "pipe", "pipe", "ipc"], windowsHide: true });
	let output = ""; child.stdout!.on("data", chunk => { output += chunk.toString(); }); child.stderr!.on("data", chunk => { output += chunk.toString(); });
	const timeout = setTimeout(() => child.kill(), 10000);
	t.after(() => { clearTimeout(timeout); if (child.exitCode === null) child.kill(); });
	child.on("message", message => { if (message === "request-started") child.send("interrupt"); });
	const exit = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
	assert.equal(exit, code, output);
	assert.doesNotMatch(output, /must not display after cancellation/);
});
