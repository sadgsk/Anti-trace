import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { Harness } from "../../src/harness/harness.ts";
import { buildSystemPrompt } from "../../src/harness/prompt.ts";
import type { ShellEnvironment } from "../../src/harness/shell-environment.ts";
import type { AgentContext } from "../../src/types.ts";
import { AssistantMessageEventStream } from "../../src/llm/event-stream.ts";
import { testModel } from "../support/harness.ts";
import { tempWorkspace } from "../support/fixtures.ts";

test("POSIX prompt retains its original text apart from the Anti-trace identity", () => {
	const expected = `You are Anti-trace, a CLI coding assistant.

Working directory: /work

Available tools:
- read
- bash
- edit
- write

Use read to examine files. Use edit for unique text replacements in an existing file. Use write to create or overwrite a whole file. Use bash to list files and run commands.

Be concise.`;
	for (const platform of ["darwin", "linux"] as const) {
		assert.equal(buildSystemPrompt({ cwd: "/work", toolNames: ["read", "bash", "edit", "write"], platform }), expected);
	}
});

test("assembled tools and prompt reach model requests together for each platform", async (t) => {
	const environments: ShellEnvironment[] = [
		{ platform: "darwin", bash: "bash" }, { platform: "linux", bash: "bash" },
		{ platform: "win32", powershell: { path: "powershell.exe", majorVersion: 5 } },
		{ platform: "win32", bash: "git-bash.exe", powershell: { path: "pwsh.exe", majorVersion: 7 } },
	];
	for (const shellEnvironment of environments) {
		const root = tempWorkspace(t);
		let request: AgentContext | undefined;
		const harness = new Harness({ cwd: root, sessionsRoot: join(root, "sessions"), shellEnvironment, model: testModel, apiKey: "test-key",
			streamFn: (_model, context) => {
				request = structuredClone({ ...context, tools: context.tools?.map(({ name, description, parameters }) => ({ name, description, parameters })) }) as AgentContext;
				const stream = new AssistantMessageEventStream();
				stream.push({ type: "done", reason: "stop", message: { role: "assistant", content: [{ type: "text", text: "ok" }], model: testModel.id, stopReason: "stop", timestamp: 0 } });
				return stream;
			} });
		await harness.prompt("hello");
		assert.ok(request);
		const names = request.tools!.map(tool => tool.name);
		assert.deepEqual(names, ["read", ...(shellEnvironment.powershell ? ["powershell"] : []), ...(shellEnvironment.bash ? ["bash"] : []), "edit", "write"]);
		if (shellEnvironment.platform === "win32") {
			assert.match(request.systemPrompt, /Platform: Windows/);
			assert.match(request.systemPrompt, /Prefer powershell/);
			assert.equal(request.systemPrompt.includes("It runs Git Bash"), !!shellEnvironment.bash);
			assert.match(request.systemPrompt, shellEnvironment.powershell!.majorVersion === 5 ? /5\.1: && and \|\| are unavailable/ : /7 or later/);
		} else assert.doesNotMatch(request.systemPrompt, /Windows|PowerShell|powershell/);
	}
});
