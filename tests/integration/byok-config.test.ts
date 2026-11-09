import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { loadByokConfig } from "../../src/config/byok.ts";
import { runCli } from "../../src/cli/main.ts";
import { getAppPaths } from "../../src/storage/app-paths.ts";

function fixture() {
	const root = resolve(mkdtempSync(join(tmpdir(), "cli-agent-config-")));
	const configsDir = getAppPaths({ cwd: root }).configsDir;
	mkdirSync(configsDir, { recursive: true });
	const path = join(configsDir, "main.json");
	return {
		root, path,
		write(config: unknown) { writeFileSync(path, JSON.stringify(config)); },
		load(options: Parameters<typeof loadByokConfig>[0] = {}) {
			return loadByokConfig({ cwd: root, configPath: path, env: {}, ...options });
		},
		cleanup() {
			assert.equal(dirname(root), resolve(tmpdir()));
			assert.match(basename(root), /^cli-agent-config-/);
			rmSync(root, { recursive: true, force: true });
		},
	};
}

function catalog() {
	return {
		version: 1,
		connections: { custom: { api: "openai-completions", baseUrl: "https://example.invalid/compat/", apiKeyEnv: "BYOK_TEST_KEY" } },
		models: {
			fast: { connection: "custom", id: "upstream-fast", contextWindow: 128000 },
			large: { connection: "custom", id: "upstream-large", name: "大模型", contextWindow: 256000, maxOutputTokens: 4096, capabilities: { images: true } },
		},
		currentModel: "large",
	};
}

test("selects one of several models sharing a connection, without credential or legacy model leakage", () => {
	const temp = fixture();
	try {
		temp.write({ ...catalog(), thinking: { enabled: false, effort: "xhigh" } });
		const loaded = temp.load({ env: { BYOK_TEST_KEY: " fake-key ", OPENAI_MODEL: "wrong-model", OPENAI_CONTEXT_WINDOW: "1" } });
		assert.equal(loaded.model.id, "upstream-large");
		assert.equal(loaded.model.name, "大模型");
		assert.equal(loaded.model.provider, "custom");
		assert.equal(loaded.model.baseUrl, "https://example.invalid/compat");
		assert.equal(loaded.model.contextWindow, 256000);
		assert.equal(loaded.model.maxOutputTokens, 4096);
		assert.deepEqual(loaded.model.capabilities, { images: true });
		assert.deepEqual(loaded.thinking, { enabled: false, effort: "xhigh" });
		assert.equal(loaded.getApiKey(), "fake-key");
		assert.equal(loaded.getApiKey("fast"), "fake-key");
		assert.doesNotMatch(JSON.stringify(loaded), /fake-key|apiKeyEnv|BYOK_TEST_KEY/);
		assert.equal(temp.load({ model: "fast" }).model.id, "upstream-fast");
		temp.write(catalog());
		assert.deepEqual(temp.load().thinking, { effort: "medium" });
	} finally { temp.cleanup(); }
});

test("missing credentials for an unselected model do not block the selected model", () => {
	const temp = fixture();
	try {
		const config = catalog();
		temp.write({ ...config, connections: { ...config.connections, local: { api: "openai-responses", baseUrl: "https://other.invalid/v1", apiKey: "local-fake-key" } },
			models: { ...config.models, other: { connection: "local", id: "other", contextWindow: 10000 } }, currentModel: "other" });
		const loaded = temp.load();
		assert.equal(loaded.getApiKey(), "local-fake-key");
		assert.throws(() => loaded.getApiKey("fast"), /BYOK_TEST_KEY/);
		assert.throws(() => loaded.getApiKey("missing"), /未找到/);
		assert.doesNotMatch(JSON.stringify(loaded), /local-fake-key/);
	} finally { temp.cleanup(); }
});

test("validates the entire catalog and rejects ambiguous or misspelled settings", () => {
	const temp = fixture();
	try {
		const config = catalog();
		const invalid = [
			{ ...config, version: 2 },
			{ ...config, surprise: true },
			{ ...config, models: {} },
			{ ...config, connections: {} },
			{ ...config, thinking: { enabled: "false" } },
			{ ...config, thinking: { effort: "minimal" } },
			{ ...config, thinking: { effort: null } },
			{ ...config, models: { bad: { connection: "custom", id: "x", contextWindow: 1.5 } } },
			{ ...config, models: { bad: { connection: "custom", id: "x", contextWindow: 0 } } },
			{ ...config, models: { bad: { connection: "custom", id: "x", contextWindow: Number.MAX_SAFE_INTEGER + 1 } } },
			{ ...config, connections: { custom: { ...config.connections.custom, headers: { a: "b" } } } },
			{ ...config, connections: { custom: { ...config.connections.custom, apiKey: "fake-key" } } },
			{ ...config, connections: { custom: { api: "openai-completions", baseUrl: "https://example.invalid/v1" } } },
			{ ...config, models: { ...config.models, bad: { connection: "missing", id: "x", contextWindow: 100 } } },
			{ ...config, models: { ...config.models, bad: { connection: "custom", id: "x", contextWindow: 100, maxOutputTokens: 101 } } },
			{ ...config, currentModel: "missing" },
		];
		for (const item of invalid) {
			temp.write(item);
			assert.throws(() => temp.load());
		}
		temp.write({ ...config, currentModel: "missing" });
		assert.equal(temp.load({ model: "fast" }).currentModel, "fast");
		assert.match(temp.load({ model: "fast" }).warnings.join("\n"), /currentModel/);
		temp.write(config);
		assert.throws(() => temp.load({ model: "missing" }), /未找到/);
	} finally { temp.cleanup(); }
});

test("invalid JSON errors never echo key values, and UTF-8 BOM is accepted", () => {
	const temp = fixture();
	try {
		writeFileSync(temp.path, '{"apiKey":"secret-do-not-echo", bad');
		assert.throws(() => temp.load(), (error: Error) => {
			assert.match(error.message, /不是有效的 JSON/);
			assert.doesNotMatch(error.message, /secret-do-not-echo/);
			return true;
		});
		writeFileSync(temp.path, "\uFEFF" + JSON.stringify(catalog()));
		assert.equal(temp.load().model.id, "upstream-large");
	} finally { temp.cleanup(); }
});

test("missing or damaged BYOK files fail even when all old OPENAI settings exist", () => {
	const temp = fixture();
	try {
		writeFileSync(join(temp.root, ".env"), "OPENAI_API_KEY=dotenv-fake-key\nOPENAI_BASE_URL=https://old.invalid/v1\nOPENAI_MODEL=dotenv-model\nOPENAI_CONTEXT_WINDOW=64000\n");
		const env = { OPENAI_MODEL: "env-model" };
		assert.throws(() => temp.load({ configPath: undefined, env }), /缺少 BYOK 配置/);
		assert.throws(() => temp.load({ configPath: temp.path }), /缺少 BYOK 配置/);
		assert.throws(() => temp.load({ configPath: "" }), /不能为空/);
		writeFileSync(temp.path, "broken");
		assert.throws(() => temp.load({ configPath: undefined }), /不是有效的 JSON/);
	} finally { temp.cleanup(); }
});

test("uses the default BYOK catalog and only its explicitly named credential variable", () => {
	const temp = fixture();
	try {
		temp.write(catalog());
		const loaded = temp.load({ configPath: undefined, env: { OPENAI_API_KEY: "legacy-fake-key" } });
		assert.equal(loaded.configPath, temp.path);
		assert.equal(loaded.model.id, "upstream-large");
		assert.throws(() => loaded.getApiKey(), /BYOK_TEST_KEY/);
	} finally { temp.cleanup(); }
});

test("uses only process environment references and never loads a local .env file", () => {
	const temp = fixture();
	try {
		temp.write(catalog());
		writeFileSync(join(temp.root, ".env"), "CLI_AGENT_CONFIG=missing.json\nBYOK_TEST_KEY=dotenv-fake-key\n");
		const env: NodeJS.ProcessEnv = {};
		assert.throws(() => temp.load({ configPath: undefined, env }).getApiKey(), /BYOK_TEST_KEY/);
		assert.deepEqual(env, {});
		const loaded = temp.load({ configPath: undefined, env: { CLI_AGENT_CONFIG: temp.path, BYOK_TEST_KEY: "env-fake-key" } });
		assert.equal(loaded.configPath, temp.path);
		assert.equal(loaded.getApiKey(), "env-fake-key");
		assert.throws(() => temp.load({ configPath: "missing.json" }), /缺少 BYOK 配置/);
	} finally { temp.cleanup(); }
});

test("distinguishes base URLs and full endpoints and rejects credentials embedded in URLs", () => {
	const temp = fixture();
	try {
		const config = catalog();
		for (const baseUrl of ["https://example.invalid/v1/chat/completions/", "https://example.invalid/v1/responses", "https://example.invalid/v1/messages", "ftp://example.invalid", "relative/v1", "https://user:secret@example.invalid/v1", "https://example.invalid/v1?key=secret", "https://example.invalid/v1#secret"]) {
			temp.write({ ...config, connections: { custom: { ...config.connections.custom, baseUrl } } });
			assert.throws(() => temp.load(), (error: Error) => { assert.doesNotMatch(error.message, /secret/); return true; });
		}
		temp.write({ ...config, connections: { custom: { ...config.connections.custom, endpoint: "https://example.invalid/custom/infer/" } } });
		assert.equal(temp.load().model.endpoint, "https://example.invalid/custom/infer/");
	} finally { temp.cleanup(); }
});

test("model settings missing from JSON cannot be supplied by old OPENAI environment variables", () => {
	const temp = fixture();
	try {
		const config = catalog();
		temp.write({ ...config, models: { main: { connection: "custom", id: "chosen-model" } }, currentModel: "main" });
		assert.throws(() => temp.load({ env: { OPENAI_CONTEXT_WINDOW: "128000", OPENAI_MODEL: "env-model" } }), /字段无效/);
	} finally { temp.cleanup(); }
});

test("CLI uses the selected model, resolved key, output limit and exact endpoint over local HTTP", async () => {
	const temp = fixture();
	const requests: Array<{ url: string; authorization?: string; body: Record<string, any> }> = [];
	const server = createServer(async (request, response) => {
		const chunks: Buffer[] = [];
		for await (const chunk of request) chunks.push(Buffer.from(chunk));
		requests.push({ url: request.url!, authorization: request.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString()) });
		response.writeHead(200, { "Content-Type": "text/event-stream" });
		response.end('data: {"choices":[{"delta":{"content":"local-ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
	});
	await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	const origin = `http://127.0.0.1:${address.port}`;
	try {
		for (const endpoint of [undefined, `${origin}/custom/infer/`]) {
			temp.write({ ...catalog(), connections: { custom: { api: "openai-completions", baseUrl: `${origin}/compat/`, endpoint, apiKey: "local-fake-key" } } });
			const stdin = new PassThrough();
			const stdout = new PassThrough();
			const stderr = new PassThrough();
			let output = "";
			stdout.on("data", chunk => { output += chunk.toString(); });
			stdin.end("hello\nworld");
			assert.equal(await runCli({ cwd: temp.root, sessionsRoot: join(temp.root, "sessions"), configPath: temp.path, streams: { stdin, stdout, stderr } }), 0);
			assert.match(output, /local-ok/);
		}
		assert.deepEqual(requests.map(request => request.url), ["/compat/chat/completions", "/custom/infer/"]);
		for (const request of requests) {
			assert.equal(request.authorization, "Bearer local-fake-key");
			assert.equal(request.body.model, "upstream-large");
			assert.equal(request.body.max_tokens, 4096);
			assert.deepEqual(request.body.messages.at(-1), { role: "user", content: "hello\nworld" });
		}
		const files = readdirSync(join(temp.root, "sessions"), { recursive: true, withFileTypes: true }).filter(entry => entry.isFile());
		assert.ok(files.length > 0);
		for (const entry of files) assert.doesNotMatch(readFileSync(join(entry.parentPath, entry.name), "utf8"), /local-fake-key|Authorization|apiKey/);
	} finally {
		server.closeAllConnections();
		await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
		temp.cleanup();
	}
});

test("CLI reports transport failures for native protocols when submitting a model request", async () => {
	const temp = fixture();
	try {
		for (const api of ["openai-responses", "anthropic-messages"]) {
			temp.write({ ...catalog(), connections: { custom: { api, baseUrl: "http://127.0.0.1:1/v1", apiKey: "fake-key" } } });
			const stderr = new PassThrough();
			const stdout = new PassThrough();
			const stdin = new PassThrough();
			let error = "";
			stderr.on("data", chunk => { error += chunk.toString(); });
			stdout.on("data", chunk => { error += chunk.toString(); });
			stdin.end("hello");
			assert.equal(await runCli({ cwd: temp.root, configPath: temp.path, sessionsRoot: join(temp.root, "sessions"), streams: { stdin, stdout, stderr } }), 1);
			assert.match(error, /fetch failed/);
		}
	} finally { temp.cleanup(); }
});
