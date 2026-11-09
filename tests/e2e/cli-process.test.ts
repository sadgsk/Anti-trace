import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { tempWorkspace } from "../support/fixtures.ts";
import { chatResponse, createHttpFixture } from "../support/http-server.ts";

async function cli(t: TestContext, cwd: string, input: string, env: NodeJS.ProcessEnv = {}, fromCmd = false) {
	const args = [
		"--import", new URL("../../node_modules/tsx/dist/loader.mjs", import.meta.url).href,
		"--import", new URL("../support/setup.ts", import.meta.url).href,
		fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url)),
		...(fromCmd ? ["--yolo"] : []),
	];
	const child = fromCmd
		? spawn(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `"${[process.execPath, ...args].map(arg => `"${arg}"`).join(" ")}"`], {
			cwd, env: { ...process.env, ...env }, windowsVerbatimArguments: true, windowsHide: true, signal: AbortSignal.timeout(30000),
		})
		: spawn(process.execPath, args, { cwd, env: { ...process.env, ...env }, windowsHide: true, signal: AbortSignal.timeout(15000) });
	t.after(() => { if (child.exitCode === null && !child.killed) child.kill(); });
	let stdout = "", stderr = "";
	child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
	child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
	const result = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
		child.once("error", reject);
		child.once("close", (code) => resolve({ code, stdout, stderr }));
	});
	child.stdin.end(input);
	return result;
}

function configure(root: string, url: string) {
	writeFileSync(join(root, "byok.json"), JSON.stringify({ version: 1, currentModel: "main",
		connections: { local: { api: "openai-completions", baseUrl: url, apiKey: "e2e-fake-secret" } },
		models: { main: { connection: "local", id: "test", contextWindow: 128000, maxOutputTokens: 2048 } },
	}));
}

test("a fresh CLI process accepts pipe input, uses local HTTP and exits successfully", async (t) => {
	const root = tempWorkspace(t);
	const http = await createHttpFixture(t, (_request, response) => { response.writeHead(200, { "content-type": "text/event-stream" }).end(chatResponse("CLI_OK")); });
	configure(root, http.url);
	const result = await cli(t, root, "你好\nmultiline input");
	assert.equal(result.code, 0, result.stderr);
	assert.match(result.stdout, /CLI_OK/);
	assert.equal(http.requests.length, 1);
	assert.match(JSON.stringify(http.requests[0]!.body), /multiline input/);
	assert.doesNotMatch(result.stdout + result.stderr, /e2e-fake-secret/);
});

test("a fresh CLI returns a nonzero exit code for a provider error without leaking credentials", async (t) => {
	const root = tempWorkspace(t);
	const http = await createHttpFixture(t, (_request, response) => { response.writeHead(401).end("e2e-fake-secret denied"); });
	configure(root, http.url);
	const result = await cli(t, root, "hello");
	assert.equal(result.code, 1);
	assert.match(result.stdout + result.stderr, /401/);
	assert.doesNotMatch(result.stdout + result.stderr, /e2e-fake-secret/);
});

test("session commands work without configuration in a standalone process", async (t) => {
	const root = tempWorkspace(t);
	const result = await cli(t, root, "/new");
	assert.equal(result.code, 0, result.stderr);
	assert.match(result.stdout, /新会话/);
});

test("pipe output remains available with CI mode enabled", async (t) => {
	const root = tempWorkspace(t);
	const http = await createHttpFixture(t, (_request, response) => { response.writeHead(200, { "content-type": "text/event-stream" }).end(chatResponse("CI_PIPE_OK")); });
	configure(root, http.url);
	const result = await cli(t, root, "hello", { CI: "true" });
	assert.equal(result.code, 0, result.stderr);
	assert.match(result.stdout, /CI_PIPE_OK/);
});

test("noninteractive default policy blocks real file writes and returns a paired result", async (t) => {
	const root = tempWorkspace(t);
	const http = await createHttpFixture(t, (_request, response, index) => {
		response.writeHead(200, { "content-type": "text/event-stream" });
		if (index === 0) response.end(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "write", function: {
			name: "write", arguments: JSON.stringify({ path: "should-not-exist.txt", content: "blocked" }),
		} }] }, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`);
		else response.end(chatResponse("permission handled"));
	});
	configure(root, http.url);
	const result = await cli(t, root, "write a file");
	assert.equal(result.code, 0, result.stderr);
	assert.equal(existsSync(join(root, "should-not-exist.txt")), false);
	assert.equal(http.requests.length, 2);
	assert.match(JSON.stringify(http.requests[1]!.body), /非交互模式无法请求权限/);
});

test("Windows launched from CMD deletes through PowerShell and completes the model round-trip", { skip: process.platform !== "win32" }, async t => {
	const root = tempWorkspace(t), file = join(root, "删除 [a] ' 空格.txt"); writeFileSync(file, "delete me");
	const http = await createHttpFixture(t, (_request, response, index) => {
		response.writeHead(200, { "content-type": "text/event-stream" });
		if (index === 0) response.end(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "delete", function: {
			name: "powershell", arguments: JSON.stringify({ command: `Remove-Item -LiteralPath '${file.replaceAll("'", "''")}'; Write-Output 'DELETE_OK'`, timeout: 10 }),
		} }] }, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`);
		else response.end(chatResponse("WINDOWS_DELETE_FINISHED"));
	});
	configure(root, http.url);
	const result = await cli(t, root, "delete the temporary file", {}, true);
	assert.equal(result.code, 0, result.stdout + result.stderr); assert.equal(existsSync(file), false);
	assert.match(result.stdout, /WINDOWS_DELETE_FINISHED/); assert.equal(http.requests.length, 2);
	const request = JSON.stringify(http.requests[0]!.body), followup = JSON.stringify(http.requests[1]!.body);
	assert.match(request, /You are Anti-trace/); assert.match(request, /Platform: Windows/); assert.match(request, /Prefer powershell/);
	assert.match(followup, /DELETE_OK/); assert.match(followup, /powershell_result/);
});
