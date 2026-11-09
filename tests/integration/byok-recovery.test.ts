import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { ByokRuntime } from "../../src/cli/byok-runtime.ts";
import { runCli } from "../../src/cli/main.ts";
import { ReplController } from "../../src/cli/repl/repl-controller.ts";
import { createPromptDraft } from "../../src/cli/input/prompt-draft.ts";
import { loadByokConfig } from "../../src/config/byok.ts";
import { ByokConfigError } from "../../src/config/errors.ts";
import { Agent } from "../../src/agent/agent.ts";
import { Harness } from "../../src/harness/harness.ts";
import { appendEntry, createSessionFile, loadSession } from "../../src/harness/session.ts";
import { streamModel } from "../../src/llm/adapter.ts";
import { createFakeStreamFn } from "../support/fake-stream.ts";
import type { StreamFn } from "../../src/types.ts";

function fixture() {
	const root = resolve(mkdtempSync(join(tmpdir(), "byok-recovery-")));
	const path = join(root, "byok.json");
	return { root, path, sessionsRoot: join(root, "sessions"),
		write(config: unknown, target = path) { writeFileSync(target, JSON.stringify(config)); },
		cleanup() {
			assert.equal(dirname(root), resolve(tmpdir()));
			assert.match(basename(root), /^byok-recovery-/);
			rmSync(root, { recursive: true, force: true });
		},
	};
}

function catalog() {
	return { version: 1, currentModel: "main",
		connections: { gateway: { api: "openai-completions", baseUrl: "http://127.0.0.1:1/v1", apiKey: "fake-secret" } },
		models: { main: { connection: "gateway", id: "first-model", contextWindow: 100000, maxOutputTokens: 4096 } },
	};
}

function runtimeFor(f: ReturnType<typeof fixture>, env: NodeJS.ProcessEnv = {}, streamFn: StreamFn = streamModel) {
	const harness = new Harness({ cwd: f.root, sessionsRoot: f.sessionsRoot, streamFn });
	const runtime = new ByokRuntime({ cwd: f.root, configPath: f.path, env }, config => {
		harness.configureModel({ model: config.model, thinking: config.thinking, getApiKey: config.getApiKey });
	});
	return { harness, runtime };
}

function seedSession(f: ReturnType<typeof fixture>) {
	const session = createSessionFile(f.root, f.sessionsRoot);
	appendEntry(session, { type: "message", message: { role: "user", content: [{ type: "text", text: "saved user" }], timestamp: 0 } });
	appendEntry(session, { type: "message", message: { role: "assistant", content: [{ type: "text", text: "saved answer" }], model: "old", stopReason: "stop", timestamp: 1 } });
	return session;
}

class Input extends PassThrough {
	isTTY = true;
	isRaw = false;
	setRawMode(value: boolean) { this.isRaw = value; return this; }
}
class Output extends PassThrough { isTTY = true; columns = 160; rows = 30; }
const delay = (ms = 50) => new Promise(resolve => setTimeout(resolve, ms));
async function until(condition: () => boolean) {
	for (let index = 0; index < 100; index++) {
		if (condition()) return;
		await delay(20);
	}
	assert.ok(condition(), "timed out waiting for terminal output");
}
async function enter(input: Input, text: string) {
	// This suite tests CLI recovery; paste timing is covered by the input suites.
	// Ordinary text + Enter is synchronous, so slow CI cannot submit during a paste merge window.
	input.write(`${text}\r`);
	await delay(0);
}

type BadCase = { name: string; expected: RegExp; requestOnly?: boolean; prepare: (f: ReturnType<typeof fixture>) => { configPath?: string; model?: string } | void };
const invalid = (name: string, expected: RegExp, edit: (config: any) => void, requestOnly = false): BadCase => ({
	name, expected, requestOnly, prepare(f) { const config = catalog(); edit(config); f.write(config); },
});
const cases: BadCase[] = [
	{ name: "missing file", expected: /缺少 BYOK 配置/, prepare() {} },
	{ name: "empty path", expected: /路径不能为空/, prepare() { return { configPath: " " }; } },
	{ name: "unreadable file", expected: /无法读取 BYOK 配置/, prepare(f) { return { configPath: f.root }; } },
	{ name: "damaged JSON", expected: /不是有效的 JSON/, prepare(f) { writeFileSync(f.path, '{"apiKey":"fake-secret", broken'); } },
	invalid("schema", /字段无效/, c => { c.models.main.contextWindow = "bad"; }),
	invalid("missing field", /字段无效/, c => { delete c.models.main.contextWindow; }),
	invalid("two credential sources", /必须且只能/, c => { c.connections.gateway.apiKeyEnv = "BYOK_TEST_KEY"; }),
	invalid("no credential source", /必须且只能/, c => { delete c.connections.gateway.apiKey; }),
	invalid("empty key", /字段无效/, c => { c.connections.gateway.apiKey = "  "; }),
	invalid("missing environment key", /缺少凭据/, c => { delete c.connections.gateway.apiKey; c.connections.gateway.apiKeyEnv = "BYOK_RECOVERY_NEVER_SET_17"; }, true),
	invalid("bad base URL", /baseUrl/, c => { c.connections.gateway.baseUrl = "https://user:fake-secret@example.invalid/v1"; }),
	invalid("bad endpoint", /endpoint/, c => { c.connections.gateway.endpoint = "bad-url"; }),
	invalid("missing connection", /不存在的连接/, c => { c.models.main.connection = "missing"; }),
	invalid("output exceeds context", /maxOutputTokens/, c => { c.models.main.maxOutputTokens = 100001; }),
	invalid("stale default", /currentModel/, c => { c.currentModel = "gone"; }),
	{ name: "missing selection", expected: /未找到 BYOK 模型/, prepare(f) { f.write(catalog()); return { model: "gone" }; } },
	invalid("Responses transport", /fetch failed/, c => { c.connections.gateway.api = "openai-responses"; }, true),
	invalid("Anthropic transport", /fetch failed/, c => { c.connections.gateway.api = "anthropic-messages"; }, true),
	invalid("adapter semantics", /connections\/gateway\/adapter/, c => { c.connections.gateway.adapter = { thinking: { mode: "effort", levels: ["off"] } }; }),
	invalid("model adapter semantics", /models\/main\/adapter/, c => { c.models.main.adapter = { thinking: { mode: "effort", levels: ["off"] } }; }),
	invalid("thinking capability conflict", /能力与 adapter 规则冲突/, c => { c.models.main.capabilities = { thinking: false }; c.models.main.adapter = { thinking: { mode: "toggle", format: "enable-thinking" } }; }),
	invalid("missing thinking rule", /没有思考控制规则/, c => { c.thinking = { enabled: true }; }, true),
	invalid("thinking budget does not fit", /最低思考预算/, c => {
		c.thinking = { enabled: true }; c.models.main.maxOutputTokens = 50;
		c.models.main.adapter = { thinking: { mode: "budget", format: "enable-thinking", budgets: { low: 100, medium: 200, high: 300, xhigh: 400, max: 500 }, minBudget: 100, answerReserveTokens: 10 } };
	}, true),
];

test("BYOK load and request failures keep the actual TTY CLI and session commands usable until /exit", async t => {
	for (const scenario of cases) await t.test(scenario.name, async () => {
		const f = fixture();
		const stdin = new Input(); const stdout = new Output(); const stderr = new PassThrough();
		let output = ""; let errors = ""; let settled = false;
		stdout.on("data", chunk => { output += chunk.toString(); });
		stderr.on("data", chunk => { errors += chunk.toString(); });
		let done: Promise<number> | undefined;
		try {
			const extra = scenario.prepare(f) ?? {};
			done = runCli({ cwd: f.root, configPath: f.path, sessionsRoot: f.sessionsRoot, ...extra, streams: { stdin, stdout, stderr } });
			void done.then(() => { settled = true; });
			await until(() => (scenario.requestOnly ? /first-model/ : scenario.expected).test(output));
			assert.equal(settled, false); assert.equal(stdin.isRaw, true);
			if (scenario.requestOnly) assert.doesNotMatch(output, scenario.expected);
			await enter(stdin, "/help");
			await until(() => output.includes("Enter 提交"));
			await enter(stdin, "/new");
			await until(() => /已开始新会话/.test(output));
			await enter(stdin, "/context");
			await until(() => (scenario.requestOnly ? /ctx 0\/100000/ : /ctx 0\/未配置/).test(output));
			await enter(stdin, "/resume");
			await until(() => /没有可恢复的会话/.test(output));
			await enter(stdin, "hello");
			assert.equal(settled, false);
			await until(() => scenario.expected.test(output));
			if (!scenario.requestOnly) await until(() => /尚无可用模型配置/.test(output));
			assert.doesNotMatch(output + errors, /fake-secret|ByokConfigError:|at loadByokConfig/);
			await enter(stdin, "/exit");
			assert.equal(await done, 0); assert.equal(stdin.isRaw, false);
		} finally {
			stdin.end(); if (done) await done;
			stdin.destroy(); stdout.destroy(); stderr.destroy(); f.cleanup();
		}
	});
});

test("noninteractive configuration failures resolve with a diagnostic and exit code, never reject or hang", async () => {
	for (const scenario of cases) {
		const f = fixture(); const stdin = new PassThrough(); const stdout = new PassThrough(); const stderr = new PassThrough();
		let error = ""; stderr.on("data", chunk => { error += chunk.toString(); }); stdout.on("data", chunk => { error += chunk.toString(); });
		try {
			const extra = scenario.prepare(f) ?? {};
			stdin.end("hello");
			assert.equal(await runCli({ cwd: f.root, configPath: f.path, sessionsRoot: f.sessionsRoot, ...extra, streams: { stdin, stdout, stderr } }), 1);
			assert.match(error, scenario.expected);
			assert.doesNotMatch(error, /fake-secret/);
		} finally { stdin.destroy(); stdout.destroy(); stderr.destroy(); f.cleanup(); }
	}
});

test("TTY repairs a missing file and stale default without restarting, then keeps commands usable", async () => {
	const f = fixture(); const stdin = new Input(); const stdout = new Output(); const stderr = new PassThrough();
	let output = ""; let settled = false;
	stdout.on("data", chunk => { output += chunk.toString(); });
	const done = runCli({ cwd: f.root, configPath: f.path, sessionsRoot: f.sessionsRoot, streams: { stdin, stdout, stderr } });
	void done.then(() => { settled = true; });
	try {
		await until(() => output.includes("缺少 BYOK 配置"));
		const config = catalog(); config.currentModel = "deleted"; f.write(config);
		await enter(stdin, "/reload"); await until(() => output.includes("currentModel 引用了不存在的模型 deleted"));
		await enter(stdin, "/model main"); await until(() => output.includes("已切换到 main"));
		await enter(stdin, "/context"); await until(() => output.includes("ctx 0/100000"));
		await enter(stdin, "/context 120000"); await until(() => output.includes("ctx 0/120000"));
		assert.equal(settled, false);
		await enter(stdin, "/exit"); assert.equal(await done, 0);
	} finally { stdin.end(); await done; stdin.destroy(); stdout.destroy(); stderr.destroy(); f.cleanup(); }
});

test("each rejected candidate preserves the last valid model, key and messages", () => {
	for (const scenario of cases.filter(scenario => !scenario.requestOnly && scenario.name !== "stale default")) {
		const f = fixture();
		try {
			f.write(catalog());
			const { runtime, harness } = runtimeFor(f);
			assert.equal(runtime.reload().ok, true);
			harness.agent.state.messages = [{ role: "user", content: [{ type: "text", text: "keep this" }], timestamp: 0 }];
			const before = JSON.stringify(harness.agent.state);
			// The missing-file scenario needs the candidate path to remain absent.
			const change = scenario.name === "missing file" ? { configPath: join(f.root, "missing.json") } : scenario.prepare(f) ?? {};
			const result = runtime.reload(change);
			assert.equal(result.ok, false, scenario.name);
			assert.match(result.message, scenario.expected);
			assert.equal(JSON.stringify(harness.agent.state), before);
			assert.equal(runtime.hasConfig, true);
		} finally { f.cleanup(); }
	}
});

test("reload keeps an explicit active selection when the file default becomes stale", () => {
	const f = fixture();
	try {
		f.write(catalog());
		const { runtime, harness } = runtimeFor(f);
		assert.equal(runtime.reload().ok, true);
		harness.agent.state.messages = [{ role: "user", content: [{ type: "text", text: "keep this" }], timestamp: 0 }];
		const before = structuredClone(harness.agent.state.messages);
		const config = catalog();
		config.currentModel = "gone";
		f.write(config);
		const result = runtime.reload();
		assert.equal(result.ok, true);
		assert.match(result.message, /currentModel.*gone/);
		assert.equal(harness.agent.state.model?.id, "first-model");
		assert.deepEqual(harness.agent.state.messages, before);
		assert.equal(runtime.selectedModel, "main");
	} finally { f.cleanup(); }
});

test("pipe uses an explicit valid selection with a stale-default warning and supports config commands", async () => {
	const f = fixture(); const stdin = new PassThrough(); const stdout = new PassThrough(); const stderr = new PassThrough();
	let output = ""; let error = "";
	stdout.on("data", chunk => { output += chunk.toString(); }); stderr.on("data", chunk => { error += chunk.toString(); });
	try {
		const config = catalog(); config.currentModel = "deleted"; f.write(config); stdin.end("/config");
		assert.equal(await runCli({ cwd: f.root, sessionsRoot: f.sessionsRoot, model: "main", streams: { stdin, stdout, stderr } }), 0);
		assert.match(error, /currentModel 引用了不存在的模型 deleted/);
		assert.match(output, /当前仍生效：main/);
	} finally { stdin.destroy(); stdout.destroy(); stderr.destroy(); f.cleanup(); }
});

test("repair, rejected reload, model switch and 401 recovery preserve a conversation over local HTTP", async () => {
	const f = fixture();
	const requests: Array<{ key?: string; body: any }> = [];
	const server = createServer(async (req, res) => {
		const chunks = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
		requests.push({ key: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString()) });
		if (req.headers.authorization === "Bearer rejected-key") { res.writeHead(401); res.end("invalid_api_key"); return; }
		res.writeHead(200, { "Content-Type": "text/event-stream" });
		res.end('data: {"choices":[{"delta":{"content":"recovered-ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
	});
	await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
	const address = server.address(); assert.ok(address && typeof address !== "string");
	const { runtime, harness: original } = runtimeFor(f);
	assert.equal(runtime.reload().ok, false);
	const repl = new ReplController({ harness: original, byok: runtime });
	const submit = (text: string) => repl.submit(createPromptDraft(text));
	try {
		await submit("blocked"); await submit("/compact");
		assert.equal(requests.length, 0); assert.equal(repl.getSnapshot().closed, false);
		const config: any = catalog(); config.connections.gateway.baseUrl = `http://127.0.0.1:${address.port}/v1`;
		config.models.other = { ...config.models.main, id: "second-model", maxOutputTokens: 2048 };
		config.currentModel = "stale";
		f.write(config);
		await submit("/model main");
		assert.equal(repl.getSnapshot().error, undefined);
		assert.match(repl.getSnapshot().entries.at(-1)!.text, /currentModel/);
		await submit("first user message");
		const previousMessages = original.agent.state.messages;
		writeFileSync(f.path, "invalid");
		await submit("/reload");
		assert.match(repl.getSnapshot().error!, /不是有效的 JSON/);
		assert.deepEqual(original.agent.state.messages, previousMessages);
		await submit("after failed reload");
		assert.equal(requests.at(-1)!.body.model, "first-model");
		config.connections.gateway.apiKey = "second-secret"; f.write(config);
		await submit("/reload");
		await submit("/model other");
		await submit("after switching");
		assert.equal(requests.at(-1)!.key, "Bearer second-secret");
		assert.equal(requests.at(-1)!.body.model, "second-model");
		assert.equal(requests.at(-1)!.body.max_tokens, 2048);
		assert.ok(requests.at(-1)!.body.messages.some((m: any) => m.content === "first user message"));
		await submit("/model nonexistent");
		assert.match(repl.getSnapshot().error!, /未找到 BYOK 模型/);
		assert.equal(original.agent.state.model?.id, "second-model");
		const nextPath = join(f.root, "config with spaces.json");
		config.currentModel = "main"; config.connections.gateway.apiKey = "rejected-key"; f.write(config, nextPath);
		await submit(`/config ${nextPath}`);
		await submit("server rejects key");
		assert.match(repl.getSnapshot().error!, /401/);
		assert.equal(repl.getSnapshot().closed, false);
		config.connections.gateway.apiKey = "repaired-secret"; f.write(config, nextPath);
		await submit("/reload"); await submit("after key repair");
		assert.equal(repl.getSnapshot().error, undefined);
		assert.equal(requests.at(-1)!.key, "Bearer repaired-secret");
		assert.ok(requests.at(-1)!.body.messages.some((m: any) => m.content === "first user message"));
		const files = readdirSync(f.sessionsRoot, { recursive: true, withFileTypes: true }).filter(f => f.isFile());
		assert.equal(files.length, 1, "reload and switching must not create new sessions");
		assert.doesNotMatch(readFileSync(join(files[0]!.parentPath, files[0]!.name), "utf8"), /fake-secret|second-secret|repaired-secret/);
	} finally {
		repl.dispose(); server.closeAllConnections();
		await new Promise<void>(resolve => server.close(() => resolve())); f.cleanup();
	}
});

test("typed credential errors, whitespace environment keys and changed environment keys remain recoverable", async () => {
	const f = fixture(); const env: NodeJS.ProcessEnv = { BYOK_KEY: " " };
	try {
		const config: any = catalog(); delete config.connections.gateway.apiKey; config.connections.gateway.apiKeyEnv = "BYOK_KEY";
		f.write(config);
		const loaded = loadByokConfig({ configPath: f.path, env });
		assert.throws(() => loaded.getApiKey(), ByokConfigError);
		assert.throws(() => loaded.getApiKey("missing"), ByokConfigError);
		const keys: Array<string | undefined> = [];
		const fake = createFakeStreamFn([{ text: "one" }, { text: "two" }]);
		const { runtime, harness } = runtimeFor(f, env, (model, context, options) => {
			keys.push(options?.apiKey); return fake(model, context, options);
		});
		assert.equal(runtime.reload().ok, true);
		await assert.rejects(harness.prompt("missing key"), /缺少凭据/);
		assert.deepEqual(harness.agent.state.messages, []);
		assert.deepEqual(keys, []);
		env.BYOK_KEY = "corrected-key";
		await harness.prompt("fixed without reload");
		env.BYOK_KEY = "updated-key";
		await harness.prompt("changed without reload");
		assert.deepEqual(keys, ["corrected-key", "updated-key"]);
		delete env.BYOK_KEY;
		await assert.rejects(harness.prompt("key removed"), /缺少凭据/);
		assert.equal(keys.length, 2, "must not reuse the cached key when resolution fails");
	} finally { f.cleanup(); }
});

test("Harness and Agent start without a placeholder model; only model operations are blocked", async () => {
	const f = fixture();
	let requests = 0;
	const streamFn: StreamFn = () => { requests++; throw new Error("must not request"); };
	try {
		const seeded = seedSession(f);
		const harness = new Harness({ cwd: f.root, sessionsRoot: f.sessionsRoot, streamFn });
		assert.equal(harness.agent.state.model, undefined);
		const names = harness.agent.state.tools.map(tool => tool.name);
		assert.ok(names.includes("read") && names.includes("edit") && names.includes("write"));
		if (process.platform === "win32") assert.ok(names.includes("powershell"));
		else assert.deepEqual(names, ["read", "bash", "edit", "write"]);
		assert.equal(harness.listSessions().length, 1);
		assert.equal(harness.resumeAt(1), true);
		const messages = structuredClone(harness.agent.state.messages);
		const persisted = readFileSync(seeded.path, "utf8");
		assert.equal(harness.contextUsage().window, undefined);
		assert.ok(harness.contextUsage().used > 0);
		await assert.rejects(harness.prompt("blocked", [{ type: "image", mimeType: "image/png", data: "ZmFrZQ==" }]), /尚无可用模型配置/);
		await assert.rejects(harness.manualCompact(), /尚无可用模型配置/);
		await assert.rejects(harness.compact(), /尚无可用模型配置/);
		assert.throws(() => harness.setContextWindow(100000), /尚无可用模型配置/);
		assert.deepEqual(harness.agent.state.messages, messages);
		assert.equal(readFileSync(seeded.path, "utf8"), persisted);
		assert.equal(readdirSync(f.sessionsRoot, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile()).length, 1);
		harness.newSession();
		assert.deepEqual(harness.agent.state.messages, []);
		assert.equal(harness.listSessions().length, 1);
		const agent = new Agent({ streamFn });
		await assert.rejects(agent.prompt("blocked"), /尚未配置模型/);
		await assert.rejects(agent.continueFromContext(), /尚未配置模型/);
		assert.deepEqual(agent.state.messages, []);
		assert.equal(agent.state.isStreaming, false);
		assert.equal(requests, 0);
	} finally { f.cleanup(); }
});

test("actual TTY resumes existing history without a config and keeps it through model repair", async () => {
	const f = fixture(); const stdin = new Input(); const stdout = new Output(); const stderr = new PassThrough();
	let output = ""; stdout.on("data", chunk => { output += chunk.toString(); });
	const seeded = seedSession(f);
	const persisted = readFileSync(seeded.path, "utf8");
	const done = runCli({ cwd: f.root, configPath: f.path, sessionsRoot: f.sessionsRoot, streams: { stdin, stdout, stderr } });
	try {
		await until(() => output.includes("缺少 BYOK 配置"));
		await enter(stdin, "/resume"); await until(() => output.includes("↑↓ 选择会话"));
		stdin.write("\r"); await until(() => output.includes("已恢复会话：saved user"));
		await enter(stdin, "/context"); await until(() => /ctx\s+\d+\s*\/\s*未配置/.test(output));
		await enter(stdin, "blocked"); await until(() => /尚无可用模型配置/.test(output));
		assert.equal(readFileSync(seeded.path, "utf8"), persisted);
		f.write(catalog());
		await enter(stdin, "/reload"); await until(() => output.includes("已加载 BYOK 配置"));
		await enter(stdin, "/context"); await until(() => /ctx\s+[1-9][\d.]*k?\s*\/\s*100000/.test(output));
		assert.ok(readFileSync(seeded.path, "utf8").startsWith(persisted));
		assert.equal(loadSession(seeded.path).messages.length, 2);
		assert.equal(loadSession(seeded.path).settings?.modelRef?.modelKey, "main");
		await enter(stdin, "/exit"); assert.equal(await done, 0);
	} finally { stdin.end(); await done; stdin.destroy(); stdout.destroy(); stderr.destroy(); f.cleanup(); }
});

test("pipe session commands succeed even when there is no usable configuration", async () => {
	const f = fixture();
	try {
		seedSession(f);
		for (const scenario of cases.filter(scenario => !scenario.requestOnly)) {
			// Keep the absent-file scenario absent after the previous commands.
			const extra = scenario.prepare(f) ?? {};
			for (const command of ["/new", "/resume", "/context", "/help"]) {
				const stdin = new PassThrough(); const stdout = new PassThrough(); const stderr = new PassThrough();
				let output = ""; let errors = "";
				stdout.on("data", chunk => { output += chunk.toString(); }); stderr.on("data", chunk => { errors += chunk.toString(); });
				stdin.end(command);
				try {
					assert.equal(await runCli({ cwd: f.root, configPath: f.path, sessionsRoot: f.sessionsRoot, ...extra, streams: { stdin, stdout, stderr } }), 0, `${scenario.name}: ${command}`);
					assert.match(errors, scenario.expected);
					assert.doesNotMatch(output, /错误：/);
					if (command === "/resume") assert.match(output, /saved user/);
				} finally { stdin.destroy(); stdout.destroy(); stderr.destroy(); }
			}
		}
	} finally { f.cleanup(); }
});

test("compaction resolves credentials on use and a missing key leaves history intact", async () => {
	const f = fixture(); const env: NodeJS.ProcessEnv = { BYOK_KEY: "first-key" };
	const keys: Array<string | undefined> = [];
	const fake = createFakeStreamFn([{ text: "answer" }, { text: "summary" }]);
	try {
		const config: any = catalog(); delete config.connections.gateway.apiKey; config.connections.gateway.apiKeyEnv = "BYOK_KEY"; f.write(config);
		const { harness, runtime } = runtimeFor(f, env, (model, context, options) => { keys.push(options?.apiKey); return fake(model, context, options); });
		assert.equal(runtime.reload().ok, true);
		await harness.prompt("ordinary request");
		harness.agent.state.messages.push({ role: "user", content: [{ type: "text", text: "x".repeat(100000) }], timestamp: 2 });
		const before = structuredClone(harness.agent.state.messages);
		env.BYOK_KEY = " ";
		await assert.rejects(harness.compact(), /缺少凭据/);
		assert.deepEqual(harness.agent.state.messages, before);
		env.BYOK_KEY = "summary-key";
		assert.equal(await harness.compact(), true);
		assert.deepEqual(keys, ["first-key", "summary-key"]);
	} finally { f.cleanup(); }
});

test("configuration application failure does not commit the candidate while a prompt is active", async () => {
	const f = fixture();
	try {
		const config: any = catalog(); config.models.other = { ...config.models.main, id: "other-model" }; f.write(config);
		const { runtime, harness } = runtimeFor(f, {}, createFakeStreamFn([{ text: "ok" }]));
		assert.equal(runtime.reload().ok, true);
		const pending = harness.prompt("active");
		assert.throws(() => runtime.reload({ model: "other" }), /while the agent is processing/);
		assert.equal(harness.agent.state.model?.id, "first-model");
		assert.match(runtime.describe(), /当前仍生效：main/);
		await pending;
		assert.equal(runtime.reload().ok, true);
		assert.equal(harness.agent.state.model?.id, "other-model");
		assert.equal(harness.agent.state.messages.length, 2);
	} finally { f.cleanup(); }
});
