import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { ByokRuntime } from "../../src/cli/byok-runtime.ts";
import { UiLocale } from "../../src/cli/locale.ts";
import { ModelSelectionStore } from "../../src/config/model-selection.ts";
import { loadByokConfig } from "../../src/config/byok.ts";
import { appendEntry, createSessionFile, listSessions, loadSession, saveSessionImage } from "../../src/harness/session.ts";
import { createPowerShellTool } from "../../src/harness/tools/powershell.ts";
import { createBashTool } from "../../src/harness/tools/bash.ts";
import { createReadTool } from "../../src/harness/tools/read.ts";
import { getAppPaths, type AppPaths } from "../../src/storage/app-paths.ts";
import { tempWorkspace } from "../support/fixtures.ts";

const catalog = () => ({ version: 1, currentModel: "main", connections: { local: {
	api: "openai-completions", baseUrl: "http://127.0.0.1:1/v1", apiKey: "storage-fake-key",
} }, models: { main: { connection: "local", id: "main-model", contextWindow: 8192 },
	other: { connection: "local", id: "other-model", contextWindow: 8192 } } });
function writeConfig(paths: AppPaths, name = "main.json") {
	mkdirSync(paths.configsDir, { recursive: true });
	const path = join(paths.configsDir, name); writeFileSync(path, JSON.stringify(catalog())); return path;
}
function runtime(paths: AppPaths, configPath?: string) {
	return new ByokRuntime({ cwd: paths.cwd, paths, configPath, env: {} }, () => {});
}

test("configuration and language survive restart across projects while project model choices remain independent", t => {
	const root = tempWorkspace(t), a = getAppPaths({ cwd: join(root, "a") }), b = getAppPaths({ cwd: join(root, "b") });
	writeConfig(a);
	const first = runtime(a); assert.equal(first.reload().ok, true); assert.equal(first.selectModel("other").ok, true);
	const second = runtime(b); assert.equal(second.reload().ok, true); assert.equal(second.selectedModel, "other");
	assert.equal(second.selectModel("main").ok, true);
	const restarted = runtime(a); assert.equal(restarted.reload().ok, true); assert.equal(restarted.selectedModel, "other");
	const fresh = runtime(getAppPaths({ cwd: join(root, "new") })); assert.equal(fresh.reload().ok, true); assert.equal(fresh.selectedModel, "main");
	new UiLocale(a.cwd, true, a).setLanguage("en");
	assert.equal(new UiLocale(b.cwd, true, b).getSnapshot(), "en");
	assert.equal(existsSync(join(root, "a", ".ant-trace")), false);
	assert.doesNotMatch(readFileSync(a.projectSelectionFile, "utf8") + readFileSync(a.defaultSelectionFile, "utf8"), /storage-fake-key/);
});

test("the same workspace has isolated configuration, selections and sessions in different profiles", t => {
	const cwd = tempWorkspace(t), a = getAppPaths({ cwd, profileId: "user-a" }), b = getAppPaths({ cwd, profileId: "user-b" });
	writeConfig(a); const first = runtime(a); assert.equal(first.reload().ok, true); first.selectModel("other");
	assert.equal(runtime(b).reload().ok, false);
	const session = createSessionFile(cwd, a);
	appendEntry(session, { type: "message", message: { role: "assistant", model: "test", stopReason: "stop", timestamp: 1, content: [{ type: "text", text: "private-a" }] } });
	assert.equal(listSessions(cwd, a).length, 1); assert.deepEqual(listSessions(cwd, b), []);
	writeConfig(b); const second = runtime(b); assert.equal(second.reload().ok, true); assert.equal(second.selectedModel, "main");
	assert.equal(new ModelSelectionStore(a.projectSelectionFile).read()?.modelKey, "other");
});

test("session messages and real image bytes remain available after reopening from the new directory", t => {
	const cwd = tempWorkspace(t), paths = getAppPaths({ cwd }), session = createSessionFile(cwd, paths);
	const image = { type: "image" as const, mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2ioAAAAASUVORK5CYII=" };
	const imagePath = saveSessionImage(session.path, image);
	appendEntry(session, { type: "message", message: { role: "user", timestamp: 1, content: [{ type: "text", text: imagePath }, image] } });
	appendEntry(session, { type: "message", message: { role: "assistant", model: "test", stopReason: "stop", timestamp: 2, content: [{ type: "text", text: "saved" }] } });
	const reopened = listSessions(cwd, getAppPaths({ cwd })); assert.equal(reopened[0]?.filePath, session.path);
	assert.equal(loadSession(reopened[0]!.filePath).messages.length, 2);
	assert.deepEqual(readFileSync(imagePath), Buffer.from(image.data, "base64"));
});

test("old workspace configuration, preferences and old home sessions are never discovered", t => {
	const cwd = tempWorkspace(t), paths = getAppPaths({ cwd });
	mkdirSync(join(cwd, ".ant-trace", "configs"), { recursive: true });
	writeFileSync(join(cwd, "byok.json"), JSON.stringify(catalog()));
	writeFileSync(join(cwd, ".ant-trace", "configs", "old.json"), JSON.stringify(catalog()));
	writeFileSync(join(cwd, ".ant-trace", "preferences.json"), '{"language":"en"}');
	const oldBucket = `--${resolve(cwd).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
	const oldRoot = join(homedir(), ".cli-agent", "sessions", oldBucket); mkdirSync(oldRoot, { recursive: true });
	const oldHistory = JSON.stringify({ type: "session", version: 1, id: "old", timestamp: new Date().toISOString(), cwd }) + "\n" +
		JSON.stringify({ type: "message", message: { role: "assistant", model: "test", stopReason: "stop", timestamp: 1, content: [{ type: "text", text: "old history" }] } }) + "\n";
	writeFileSync(join(oldRoot, "old.jsonl"), oldHistory);
	assert.equal(runtime(paths).reload().ok, false); assert.deepEqual(runtime(paths).profiles.list(join(paths.configsDir, "main.json")), []);
	assert.equal(new UiLocale(cwd, true, paths).getSnapshot(), "zh"); assert.deepEqual(listSessions(cwd, paths), []);
	assert.equal(readFileSync(join(oldRoot, "old.jsonl"), "utf8"), oldHistory);
});

test("missing saved references fall back with a warning and explicit broken configuration fails", t => {
	const cwd = tempWorkspace(t), paths = getAppPaths({ cwd }); writeConfig(paths);
	new ModelSelectionStore(paths.projectSelectionFile).save({ configPath: join(cwd, "missing.json"), modelKey: "other" });
	const restored = runtime(paths).reload(); assert.equal(restored.ok, true);
	assert.ok(restored.ok && restored.warnings.some(text => text.includes("已不存在")));
	assert.equal(runtime(paths, join(cwd, "missing.json")).reload().ok, false);
	writeFileSync(paths.defaultSelectionFile, "{broken"); writeFileSync(paths.projectSelectionFile, "{broken");
	assert.equal(runtime(paths).reload().ok, true);
	assert.equal(loadByokConfig({ cwd, env: {} }).configPath, join(paths.configsDir, "main.json"));
});

test("preference write failures keep the active model usable and preserve existing data", t => {
	const cwd = tempWorkspace(t), paths = getAppPaths({ cwd }), config = writeConfig(paths), original = readFileSync(config, "utf8");
	mkdirSync(dirname(paths.projectRoot), { recursive: true }); writeFileSync(paths.projectRoot, "blocked");
	const active = runtime(paths), result = active.reload(); assert.equal(result.ok, true); assert.equal(active.hasConfig, true);
	assert.ok(result.ok && result.warnings.some(text => text.includes("保存失败")));
	assert.equal(readFileSync(config, "utf8"), original); assert.equal(readFileSync(paths.projectRoot, "utf8"), "blocked");
	mkdirSync(paths.preferencesFile); const locale = new UiLocale(cwd, true, paths);
	assert.throws(() => locale.setLanguage("en"), /保存失败/); assert.equal(locale.getSnapshot(), "zh");
	assert.equal(readdirSync(paths.appRoot).some(name => name.endsWith(".tmp")), false);
});

test("multiple configurations require a choice and explicit paths take priority over saved defaults", t => {
	const cwd = tempWorkspace(t), paths = getAppPaths({ cwd }), first = writeConfig(paths), second = writeConfig(paths, "second.json");
	const choose = runtime(paths), initial = choose.reload(); assert.equal(initial.ok, false); assert.match(initial.message, /多个模型配置/);
	assert.equal(choose.reload({ configPath: second }).ok, true);
	const envOverride = new ByokRuntime({ cwd, paths, env: { CLI_AGENT_CONFIG: first } }, () => {});
	assert.equal(envOverride.reload().ok, true); assert.equal(envOverride.configPath, first);
	const explicit = new ByokRuntime({ cwd, paths, configPath: second, env: { CLI_AGENT_CONFIG: join(cwd, "missing.json") } }, () => {});
	assert.equal(explicit.reload().ok, true); assert.equal(explicit.configPath, second);
});

test("an explicit configuration choice after failed startup replaces the user default", t => {
	const cwd = tempWorkspace(t), paths = getAppPaths({ cwd }), chosen = writeConfig(paths), previousDefault = writeConfig(paths, "previous.json");
	const broken = join(paths.configsDir, "broken.json"); writeFileSync(broken, "{broken");
	new ModelSelectionStore(paths.projectSelectionFile).save({ configPath: broken, modelKey: "main" });
	new ModelSelectionStore(paths.defaultSelectionFile).save({ configPath: previousDefault, modelKey: "main" });
	const active = runtime(paths); assert.equal(active.reload().ok, false);
	assert.equal(active.reload({ configPath: chosen }).ok, true);
	assert.equal(new ModelSelectionStore(paths.defaultSelectionFile).read()?.configPath, chosen);
});

test("large shell output is stored under the profile while execution and relative reads use the workspace", async t => {
	const cwd = tempWorkspace(t), paths = getAppPaths({ cwd, profileId: "user-a" });
	writeFileSync(join(cwd, "marker.txt"), "WORKSPACE_MARKER");
	const tool = process.platform === "win32" ? createPowerShellTool(cwd, undefined, paths) : createBashTool(cwd, undefined, paths);
	const command = process.platform === "win32" ? "[Console]::Write((Get-Location).Path + ':' + ('x' * 40000))" : "pwd; printf '%040000d' 0";
	const result = await tool.execute("output", { command });
	assert.equal(result.details.truncated, true); assert.ok(result.details.outputPath?.startsWith(paths.toolResultsDir));
	const output = readFileSync(result.details.outputPath!, "utf8"); assert.ok(output.includes(paths.cwd.replaceAll("\\", "/")) || output.includes(paths.cwd));
	const read = await createReadTool(cwd).execute("read", { path: "marker.txt" });
	assert.match(JSON.stringify(read.content), /WORKSPACE_MARKER/);
	const saved = await createReadTool(cwd).execute("read-output", { path: result.details.outputPath! });
	assert.ok(saved.content.length > 0); assert.equal(existsSync(join(cwd, ".ant-trace")), false);
});
