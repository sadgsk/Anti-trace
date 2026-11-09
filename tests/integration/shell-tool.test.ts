import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { createBashTool, type BashToolDetails } from "../../src/harness/tools/bash.ts";
import { BASH_OUTPUT_MAX_BYTES } from "../../src/harness/tools/bash-output.ts";
import { createShellTool } from "../../src/harness/tools/shell.ts";
import type { AgentToolResult } from "../../src/types.ts";
import { tempWorkspace, waitFor } from "../support/fixtures.ts";
import { getAppPaths } from "../../src/storage/app-paths.ts";

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

test("shell has a default deadline, closes stdin, and rejects spawn errors without hanging", async t => {
	const root = tempWorkspace(t);
	const config = { name: "bash" as const, path: process.execPath, args: (source: string) => ["-e", source], description: "fixture" };
	const input = await createShellTool(root, config).execute("stdin", { command: "process.stdin.resume();process.stdin.on('end',()=>console.log('STDIN_EOF'));" });
	assert.match(text(input), /STDIN_EOF/);
	const short = createShellTool(root, { ...config, defaultTimeout: 0.05 });
	const result = await short.execute("default", { command: "setInterval(()=>{},1000)" });
	assert.equal(result.details.timedOut, true);
	await assert.rejects(createShellTool(root, { ...config, path: join(root, "missing-executable") }).execute("spawn", { command: "" }), /ENOENT/);
});

test("Bash deletion works in a Unicode directory with spaces", async t => {
	const root = tempWorkspace(t), cwd = join(root, "中文 空格"); mkdirSync(cwd);
	writeFileSync(join(cwd, "待删除 [a].txt"), "delete me");
	const result = await createBashTool(cwd).execute("delete", { command: "test -n \"$BASH_VERSION\" && rm -- '待删除 [a].txt' && printf '%s\\n' 'DELETE_OK'" });
	assert.equal(result.details.exitCode, 0, text(result));
	assert.equal(existsSync(join(cwd, "待删除 [a].txt")), false); assert.match(text(result), /DELETE_OK/);
});

test("a descendant retaining output pipes cannot keep the shell tool waiting forever", { skip: process.platform === "win32" }, async t => {
	const root = tempWorkspace(t), ready = join(root, "orphan-pid");
	const result = await createBashTool(root).execute("orphan", { command: command(root,
		`const c=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'});require('node:fs').writeFileSync(${JSON.stringify(ready)},String(c.pid));console.log('parent done');process.exit(0);`) });
	const pid = Number(readFileSync(ready, "utf8"));
	t.after(() => { try { process.kill(pid, "SIGKILL"); } catch {} });
	assert.match(text(result), /parent done/); assert.equal(result.details.outputDrainTimedOut, true);
	assert.ok(result.details.durationMs! < 10000);
});

function text(result: AgentToolResult): string {
	return result.content.filter(block => block.type === "text").map(block => block.text).join("");
}

function metadata(output: string): BashToolDetails {
	const marker = "\n[bash_result]\n";
	const start = output.lastIndexOf(marker);
	assert.ok(start >= 0, "metadata must be in model-visible content");
	return JSON.parse(output.slice(start + marker.length).split("\n[/bash_result]")[0]!);
}

async function emitFile(root: string, data: Buffer, exitCode = 0) {
	const fixture = join(root, "raw-output.bin");
	writeFileSync(fixture, data);
	return createBashTool(root).execute("output", { command: command(root,
		`process.exitCode=${exitCode};require('node:fs').createReadStream(${JSON.stringify(fixture)}).pipe(process.stdout);`) });
}

test("empty and short shell output returns complete bytes and metadata without a log", async (t) => {
	for (const original of [Buffer.alloc(0), Buffer.from("hello 世界\r\n🙂\n")]) {
		const root = tempWorkspace(t), result = await emitFile(root, original), output = text(result);
		const meta = metadata(output);
		assert.equal(meta.truncated, false);
		assert.equal(meta.totalBytes, original.length);
		assert.equal(meta.returnedBytes, original.length);
		assert.deepEqual(meta.returnedByteRanges, original.length ? [{ start: 0, endExclusive: original.length }] : []);
		assert.equal(meta.outputPath, null);
		assert.equal(meta.exitCode, 0);
		assert.equal(meta.timedOut, false);
		assert.equal(meta.interrupted, false);
		assert.ok(output.startsWith(original.length ? original.toString("utf8") : "(no output)"));
	assert.equal(existsSync(getAppPaths({ cwd: root }).toolResultsDir), false);
		for (const key of Object.keys(meta) as Array<keyof BashToolDetails>) assert.deepEqual(result.details[key], meta[key]);
	}
});

for (const bytes of [BASH_OUTPUT_MAX_BYTES - 1, BASH_OUTPUT_MAX_BYTES, BASH_OUTPUT_MAX_BYTES + 1]) {
	test(`shell output boundary: ${bytes} bytes`, async (t) => {
		const root = tempWorkspace(t), original = Buffer.alloc(bytes, "x"), result = await emitFile(root, original);
		const meta = metadata(text(result));
		assert.equal(meta.totalBytes, bytes);
		assert.equal(meta.truncated, bytes > BASH_OUTPUT_MAX_BYTES);
		assert.equal(meta.returnedBytes, Math.min(bytes, BASH_OUTPUT_MAX_BYTES));
		if (meta.truncated) assert.deepEqual(readFileSync(meta.outputPath!), original);
		else assert.equal(meta.outputPath, null);
	});
}

test("large shell output retains a full log and exact head/tail ranges while reporting failure", async (t) => {
	const root = tempWorkspace(t);
	const original = Buffer.from("HEAD\n" + "middle-only-content\n".repeat(60000) + "TAIL\n");
	const result = await emitFile(root, original, 7), output = text(result), meta = metadata(output);
	assert.equal(meta.truncated, true);
	assert.equal(meta.exitCode, 7);
	assert.equal(meta.totalBytes, original.length);
	assert.ok(isAbsolute(meta.outputPath!));
	assert.deepEqual(readFileSync(meta.outputPath!), original);
	assert.equal(meta.returnedBytes, BASH_OUTPUT_MAX_BYTES);
	assert.ok(Buffer.byteLength(output) < BASH_OUTPUT_MAX_BYTES + 2048, "only bounded preview plus metadata is returned");
	assert.ok(output.startsWith("HEAD\n"));
	assert.match(output, /Output truncated.*omitted/);
	assert.match(output, /TAIL\n/);
	assert.match(output, /code 7/);
	assert.match(output, /output above is incomplete/);
	assert.match(output, /Use read/);
	const [head, tail] = meta.returnedByteRanges!;
	assert.equal(head!.start, 0);
	assert.equal(tail!.endExclusive, original.length);
	assert.ok(head!.endExclusive < tail!.start);
	assert.ok(output.startsWith(original.subarray(head!.start, head!.endExclusive).toString("utf8")));
	assert.ok(output.includes(original.subarray(tail!.start, tail!.endExclusive).toString("utf8")));
	assert.equal(meta.returnedBytes, meta.returnedByteRanges!.reduce((sum, range) => sum + range.endExclusive - range.start, 0));
	assert.equal(meta.totalLines, original.toString("utf8").split("\n").length);
	const { liveLines: _liveLines, ...details } = result.details;
	assert.deepEqual(metadata(output), details);
});

test("UTF-8 preview boundaries preserve Chinese and emoji and describe actual saved byte slices", async (t) => {
	const root = tempWorkspace(t), original = Buffer.from("中🙂文\n".repeat(10000));
	const result = await emitFile(root, original), output = text(result), meta = metadata(output);
	assert.deepEqual(readFileSync(meta.outputPath!), original);
	assert.doesNotMatch(output, /\uFFFD/);
	assert.ok(meta.returnedBytes! <= BASH_OUTPUT_MAX_BYTES);
	for (const range of meta.returnedByteRanges!) {
		const slice = original.subarray(range.start, range.endExclusive);
		const decoded = new TextDecoder("utf-8", { fatal: true }).decode(slice);
		assert.ok(output.includes(decoded));
		assert.equal(Buffer.byteLength(decoded), slice.length);
	}
	assert.equal(meta.returnedBytes, meta.returnedByteRanges!.reduce((sum, range) => sum + range.endExclusive - range.start, 0));
});

test("stdout and stderr both survive spilling, preserving each stream's byte order", async (t) => {
	const root = tempWorkspace(t);
	const result = await createBashTool(root).execute("mixed", { command: command(root,
		"const {once}=require('node:events');(async()=>{for(let i=0;i<500;i++){for(const [s,p] of [[process.stdout,'OUT'],[process.stderr,'ERR']]){if(!s.write(p+String(i).padStart(4,'0')+':'+('x'.repeat(100))+'\\n'))await once(s,'drain');}}})();") });
	const meta = metadata(text(result)), saved = readFileSync(meta.outputPath!, "utf8");
	assert.equal(meta.totalBytes, Buffer.byteLength(saved));
	for (const prefix of ["OUT", "ERR"]) {
		assert.deepEqual([...saved.matchAll(new RegExp(`${prefix}(\\d{4}):`, "g"))].map(match => Number(match[1])), Array.from({ length: 500 }, (_, i) => i));
	}
});

test("timeout and abort retain bounded partial output and accurate execution status", async (t) => {
	for (const abort of [false, true]) {
		const root = tempWorkspace(t), ready = join(root, "ready"), controller = new AbortController();
		const source = `process.stdout.write('x'.repeat(100000),()=>{require('node:fs').writeFileSync(${JSON.stringify(ready)},'ready');setTimeout(()=>{},500);});`;
		const tool = createBashTool(root), running = tool.execute("stop", { command: command(root, source), ...(abort ? {} : { timeout: 0.25 }) }, controller.signal);
		// Observe rejection immediately, even while waiting for the fixture's ready marker.
		const observed = running.then(result => ({ result, error: undefined }), error => ({ result: undefined, error }));
		await waitFor(() => existsSync(ready), "output fixture ready");
		if (abort) controller.abort();
		const outcome = await observed;
		const output = outcome.result ? text(outcome.result) : String(outcome.error?.message);
		const meta = metadata(output);
		assert.equal(meta.truncated, true);
		assert.equal(meta.timedOut, !abort);
		assert.equal(meta.interrupted, abort);
		assert.equal(meta.totalBytes, 100000);
		assert.equal(readFileSync(meta.outputPath!).length, 100000);
		if (abort) assert.match(output, /Command aborted/);
		else assert.match(output, /timed out/);
	}
});

test("pre-aborted shell never executes or creates output files", async (t) => {
	const root = tempWorkspace(t), marker = join(root, "must-not-exist");
	await assert.rejects(createBashTool(root).execute("abort", { command: command(root,
		`require('node:fs').writeFileSync(${JSON.stringify(marker)},'bad');`) }, AbortSignal.abort()), /Command aborted/);
	assert.equal(existsSync(marker), false);
	assert.equal(existsSync(join(root, ".ant-trace")), false);
});

test("failed log creation reports an error instead of claiming a saved complete output", async (t) => {
	const root = tempWorkspace(t);
	const outputParent = getAppPaths({ cwd: root }).projectRoot;
	mkdirSync(join(outputParent, ".."), { recursive: true });
	writeFileSync(outputParent, "a file blocks the log directory");
	await assert.rejects(emitFile(root, Buffer.alloc(100000, "x")), error => {
		assert.match(String(error), /Could not save complete bash output/);
		assert.doesNotMatch(String(error), /\[bash_result\]/);
		return true;
	});
});

test("a late disk write failure closes and removes the incomplete log without hanging", async (t) => {
	const root = tempWorkspace(t), handle = await open(join(root, "handle-probe"), "w");
	const prototype = Object.getPrototypeOf(handle) as FileHandle;
	await handle.close();
	const originalWrite = prototype.writeFile;
	let writes = 0;
	prototype.writeFile = async function(data, options) {
		if (++writes === 2) {
			// Let the fast fixture exit before the asynchronous write reports EIO.
			await delay(30);
			throw Object.assign(new Error("injected disk write failure"), { code: "EIO" });
		}
		return originalWrite.call(this, data, options);
	};
	try {
		await assert.rejects(emitFile(root, Buffer.alloc(200000, "x")), /Could not save complete bash output: injected disk write failure/);
		assert.ok(writes >= 2);
		assert.deepEqual(readdirSync(getAppPaths({ cwd: root }).toolResultsDir), [], "partial log must not survive as an apparently complete file");
	} finally { prototype.writeFile = originalWrite; }
});

test("sequential and concurrent invocations, including reused call IDs, keep separate complete logs", async (t) => {
	const root = tempWorkspace(t), tool = createBashTool(root);
	const scripts = ["a", "b", "c"].map((value, index) => {
		const directory = join(root, String(index)); mkdirSync(directory);
		return command(directory, `process.stdout.write('${value}'.repeat(100000));`);
	});
	const first = await tool.execute("same-id", { command: scripts[0]! });
	const results = [first, ...await Promise.all(scripts.slice(1).map(script => tool.execute("same-id", { command: script })))];
	const paths = results.map(result => metadata(text(result)).outputPath!);
	assert.equal(new Set(paths).size, 3);
	for (const [index, path] of paths.entries()) assert.deepEqual(readFileSync(path), Buffer.alloc(100000, ["a", "b", "c"][index]!));
	assert.equal(readdirSync(getAppPaths({ cwd: root }).toolResultsDir).length, 3);
});
