import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { tempWorkspace } from "../support/fixtures.ts";
import { chatResponse, createHttpFixture } from "../support/http-server.ts";
import { getAppPaths } from "../../src/storage/app-paths.ts";
import { listSessions } from "../../src/harness/session.ts";
import { cli, configureCli } from "../support/cli-process.ts";

test("a fresh CLI process accepts pipe input, uses local HTTP and exits successfully", async (t) => {
	const root = tempWorkspace(t);
	const http = await createHttpFixture(t, (_request, response) => { response.writeHead(200, { "content-type": "text/event-stream" }).end(chatResponse("CLI_OK")); });
	configureCli(root, http.url);
	const result = await cli(t, root, "你好\nmultiline input");
	assert.equal(result.code, 0, result.stderr);
	assert.match(result.stdout, /CLI_OK/);
	assert.equal(http.requests.length, 1);
	assert.match(JSON.stringify(http.requests[0]!.body), /multiline input/);
	assert.doesNotMatch(result.stdout + result.stderr, /e2e-fake-secret/);
});

test("fresh processes share user configuration and persist separate project sessions without workspace state", async t => {
	const a = tempWorkspace(t), b = tempWorkspace(t), paths = getAppPaths({ cwd: a });
	const http = await createHttpFixture(t, (request, response) => {
		const serialized = JSON.stringify(request.body);
		assert.ok(serialized.includes(a.replaceAll("\\", "/")) || serialized.includes(b.replaceAll("\\", "/")));
		response.writeHead(200, { "content-type": "text/event-stream" }).end(chatResponse("USER_STORAGE_OK"));
	});
	mkdirSync(paths.configsDir, { recursive: true });
	writeFileSync(join(paths.configsDir, "main.json"), JSON.stringify({ version: 1, currentModel: "main",
		connections: { local: { api: "openai-completions", baseUrl: http.url, apiKey: "storage-e2e-key" } },
		models: { main: { connection: "local", id: "test", contextWindow: 8192, maxOutputTokens: 2048 } },
	}));
	for (const cwd of [a, b]) {
		const result = await cli(t, cwd, "hello"); assert.equal(result.code, 0, result.stderr);
		assert.match(result.stdout, /USER_STORAGE_OK/); assert.doesNotMatch(result.stdout + result.stderr, /storage-e2e-key/);
		assert.equal(existsSync(join(cwd, ".ant-trace")), false);
		assert.equal(listSessions(cwd).length, 1);
	}
	assert.equal(http.requests.length, 2);
});

test("a fresh CLI returns a nonzero exit code for a provider error without leaking credentials", async (t) => {
	const root = tempWorkspace(t);
	const http = await createHttpFixture(t, (_request, response) => { response.writeHead(401).end("e2e-fake-secret denied"); });
	configureCli(root, http.url);
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
	configureCli(root, http.url);
	const result = await cli(t, root, "hello", { CI: "true" });
	assert.equal(result.code, 0, result.stderr);
	assert.match(result.stdout, /CI_PIPE_OK/);
});
