import { PassThrough } from "node:stream";
import { join } from "node:path";
import { Harness } from "../../src/harness/harness.ts";
import { runCli } from "../../src/cli/main.ts";
import { createFakeStreamFn } from "./fake-stream.ts";
import { deferred } from "./fixtures.ts";
import { testModel } from "./harness.ts";

// Emit the signal inside this isolated process so both Windows and POSIX exercise
// runCli's own signal handler, without interrupting the node:test runner.
const root = process.argv[2]!, signal = process.argv[3]!;
const release = deferred();
process.on("message", message => {
	if (message === "interrupt") { process.emit(signal as "SIGINT"); release.resolve(); }
});
const harness = new Harness({ cwd: root, sessionsRoot: join(root, "sessions"), model: testModel, apiKey: "test-only",
	streamFn: async (model, context, options) => {
		process.send?.("request-started");
		await release.promise;
		return createFakeStreamFn([{ text: "must not display after cancellation" }])(model, context, options);
	},
});
const stdin = new PassThrough(); stdin.end("current task");
process.exitCode = await runCli({ cwd: root, harness, streams: { stdin, stdout: process.stdout, stderr: process.stderr } });
process.disconnect?.();
