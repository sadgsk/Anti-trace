import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { createBashTool } from "../../src/harness/tools/bash.ts";
import { createPowerShellTool } from "../../src/harness/tools/powershell.ts";
import { detectShellEnvironment } from "../../src/harness/shell-environment.ts";
import { createShellTool } from "../../src/harness/tools/shell.ts";
import { powerShellArgs } from "../../src/harness/tools/powershell.ts";
import type { AgentToolResult } from "../../src/types.ts";
import { Harness } from "../../src/harness/harness.ts";
import { createScriptedModel } from "../support/scripted-model.ts";
import { testModel } from "../support/harness.ts";
import { tempWorkspace, waitFor } from "../support/fixtures.ts";

const text = (result: AgentToolResult) => result.content.filter(block => block.type === "text").map(block => block.text).join("");
const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;

test("Windows executes real Git Bash and both PowerShell editions", { skip: process.platform !== "win32" }, async t => {
	const shells = detectShellEnvironment();
	assert.ok(shells.bash, "Windows CI must provide Git Bash; do not silently skip the regression");
	assert.ok(shells.powershell && shells.powershell.majorVersion >= 7, "Windows CI must provide PowerShell 7");
	const root = tempWorkspace(t), cwd = join(root, "中文 空格 [目录] & 'quote"); mkdirSync(cwd);
	const editions = [shells.powershell, { path: join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), majorVersion: 5 }];
	for (const config of editions) {
		await t.test(`PowerShell ${config.majorVersion}: deletion, Unicode, quotes, native exits and noninteractive input`, async () => {
			const tool = createPowerShellTool(cwd, config), file = join(cwd, "待删除 [a] & 'b.txt");
			writeFileSync(file, "delete me");
			const result = await tool.execute("delete", { command: `Remove-Item -LiteralPath ${quote(file)}; Write-Output '删除成功 世界🙂'`, timeout: 10 });
			assert.equal(result.details.exitCode, 0, text(result)); assert.equal(existsSync(file), false);
			assert.match(text(result), /删除成功 世界🙂/);
			assert.equal(text(result).includes("#< CLIXML"), false, "module initialization must not leak serialized progress");
			const native = join(cwd, "native.cjs");
			writeFileSync(native, "console.log('原样 stdout🙂');console.error('stderr marker');process.exit(7)");
			const failure = await tool.execute("native", { command: `& ${quote(process.execPath)} ${quote(native)}`, timeout: 10 });
			assert.equal(failure.details.exitCode, 7, text(failure)); assert.match(text(failure), /原样 stdout🙂/); assert.match(text(failure), /stderr marker/);
			writeFileSync(native, "console.error('benign stderr');process.exit(0)");
			assert.equal((await tool.execute("stderr", { command: `& ${quote(process.execPath)} ${quote(native)}`, timeout: 10 })).details.exitCode, 0);
			assert.notEqual((await tool.execute("missing", { command: "Get-Item -LiteralPath './missing-file'", timeout: 10 })).details.exitCode, 0);
			assert.notEqual((await tool.execute("syntax", { command: "if (", timeout: 10 })).details.exitCode, 0);
			const input = await tool.execute("input", { command: "Read-Host 'input'", timeout: 10 });
			assert.notEqual(input.details.exitCode, 0); assert.equal(input.details.timedOut, false);
			const large = await tool.execute("large", { command: "Write-Output ('中文🙂' * 15000)", timeout: 10 });
			assert.equal(large.details.truncated, true); assert.ok(large.details.outputPath);
			const saved = readFileSync(large.details.outputPath);
			const decoded = new TextDecoder("utf-8", { fatal: true }).decode(saved);
			assert.match(decoded, /中文🙂/);
			assert.equal(decoded.includes("#< CLIXML"), false, "the full log must not contain serialized initialization progress");
			assert.equal(text(large).includes("\uFFFD"), false, "Unicode preview must not contain replacement characters");
		});
	}
	writeFileSync(join(cwd, "待删除.txt"), "delete me");
	writeFileSync(join(cwd, "run 脚本.sh"), `test -n "$BASH_VERSION" || exit 91\nrm -- '待删除.txt'\nprintf '%s\\n' 'BASH_DELETE_OK'\n`);
	const bash = await createBashTool(cwd, shells.bash).execute("bash", { command: "source './run 脚本.sh'", timeout: 10 });
	assert.equal(bash.details.exitCode, 0, text(bash)); assert.match(text(bash), /BASH_DELETE_OK/); assert.equal(existsSync(join(cwd, "待删除.txt")), false);
});

test("Windows shell cancellation terminates descendants and keeps partial logs", { skip: process.platform !== "win32" }, async t => {
	const shells = detectShellEnvironment(); assert.ok(shells.powershell); assert.ok(shells.bash);
	const root = tempWorkspace(t), ready = join(root, "ready"), script = join(root, "tree.cjs");
	writeFileSync(script, `const fs=require('node:fs'),cp=require('node:child_process');const child=cp.spawn(process.execPath,['-e',"setInterval(()=>{},1000)"],{stdio:'inherit'});fs.writeFileSync(${JSON.stringify(ready)},String(child.pid));console.log('tree ready');setInterval(()=>{},1000);`);
	for (const tool of [createPowerShellTool(root, shells.powershell), createBashTool(root, shells.bash)]) {
		const controller = new AbortController();
		let outputReceived = false;
		const command = tool.name === "powershell" ? `& ${quote(process.execPath)} ${quote(script)}` : `"${process.execPath}" "${script}"`;
		const running = tool.execute("tree", { command, timeout: 15 }, controller.signal, update => {
			if (update.details?.liveLines?.some(line => line.includes("tree ready"))) outputReceived = true;
		}).then(value => ({ value }), error => ({ error }));
		await waitFor(() => outputReceived && existsSync(ready), "child tree and partial output ready", 10000);
		const pid = Number(readFileSync(ready, "utf8"));
		controller.abort();
		const outcome = await running; assert.ok("error" in outcome); assert.match(String(outcome.error), /tree ready.*Command aborted/s);
		await waitFor(() => { try { process.kill(pid, 0); return false; } catch { return true; } }, "descendant terminated");
		// A distinct marker is needed for the next tool invocation.
		await import("node:fs/promises").then(fs => fs.unlink(ready));
	}
	const short = createShellTool(root, { name: "powershell", path: shells.powershell.path, args: powerShellArgs, description: "test", defaultTimeout: 0.1 });
	const result = await short.execute("default-timeout", { command: "Start-Sleep -Seconds 30" });
	assert.equal(result.details.timedOut, true);
});

test("Windows without a Bash tool completes a real PowerShell deletion and follows up", { skip: process.platform !== "win32" }, async t => {
	const root = tempWorkspace(t), shells = detectShellEnvironment(); assert.ok(shells.powershell);
	const noGit = detectShellEnvironment("win32", {
		PATH: dirname(shells.powershell.path), ProgramFiles: join(root, "empty"), "ProgramFiles(x86)": join(root, "empty-x86"), SystemRoot: process.env.SystemRoot,
	});
	assert.equal(noGit.bash, undefined); assert.ok(noGit.powershell);
	writeFileSync(join(root, "delete-me.txt"), "delete me");
	const scripted = createScriptedModel([
		{ toolCalls: [{ id: "delete", name: "powershell", arguments: { command: "Remove-Item -LiteralPath './delete-me.txt'" } }] },
		{ text: "done" },
	]);
	const harness = new Harness({ cwd: root, sessionsRoot: join(root, "sessions"), model: testModel, apiKey: "test-only-key", streamFn: scripted.streamFn,
		shellEnvironment: noGit });
	await harness.prompt("delete the temporary file");
	assert.equal(existsSync(join(root, "delete-me.txt")), false); assert.equal(scripted.requests.length, 2);
	assert.ok(!scripted.requests[0]!.context.tools!.some(tool => tool.name === "bash"));
	assert.doesNotMatch(scripted.requests[0]!.context.systemPrompt ?? "", /Git Bash/);
	assert.equal(harness.agent.state.isStreaming, false);
});
