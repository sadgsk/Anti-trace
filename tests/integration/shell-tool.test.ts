import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { createBashTool } from "../../src/harness/tools/bash.ts";
import { tempWorkspace } from "../support/fixtures.ts";

function command(root: string, source: string): string {
	const script = join(root, "shell fixture.cjs");
	writeFileSync(script, source);
	return `"${process.execPath}" "${script}"`;
}

test("shell captures stdout, stderr, Unicode and nonzero exits on the current OS", async (t) => {
	const root = tempWorkspace(t);
	const result = await createBashTool(root).execute("shell", { command: command(root, "console.log('hello 世界');console.error('stderr marker');process.exitCode=7;") });
	assert.equal(result.details.exitCode, 7);
	const output = result.content[0]?.type === "text" ? result.content[0].text : "";
	assert.match(output, /hello 世界/);
	assert.match(output, /stderr marker/);
	assert.match(output, /code 7/);
});

test("shell reports timeouts and returns after the fixture process exits", async (t) => {
	const root = tempWorkspace(t);
	// Self-terminates even on systems where killing a shell does not kill its descendants.
	const result = await createBashTool(root).execute("shell", { command: command(root, "setTimeout(()=>console.log('finished'),300);"), timeout: 0.05 });
	assert.equal(result.details.timedOut, true);
	assert.match(result.content[0]?.type === "text" ? result.content[0].text : "", /timed out/);
});

test("shell rejects invalid timeout values before executing a command", async (t) => {
	const tool = createBashTool(tempWorkspace(t));
	for (const timeout of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
		await assert.rejects(tool.execute("invalid", { command: "echo should-not-run", timeout }), /Invalid timeout/);
	}
});
