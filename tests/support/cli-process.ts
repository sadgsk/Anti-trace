import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { fileURLToPath } from "node:url";

export async function cli(t: TestContext, cwd: string, input: string, env: NodeJS.ProcessEnv = {}, fromCmd = false) {
	const args = [
		"--import", new URL("../../node_modules/tsx/dist/loader.mjs", import.meta.url).href,
		"--import", new URL("./setup.ts", import.meta.url).href,
		fileURLToPath(new URL("../../src/cli/bin.ts", import.meta.url)),
		...(fromCmd ? ["--yolo"] : []),
	];
	const child = fromCmd
		? spawn(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `"${[process.execPath, ...args].map(arg => `"${arg}"`).join(" ")}"`], {
			cwd, env: { ...process.env, CLI_AGENT_CONFIG: existsSync(join(cwd, "byok.json")) ? join(cwd, "byok.json") : undefined, ...env }, windowsVerbatimArguments: true, windowsHide: true, signal: AbortSignal.timeout(30000),
		})
		: spawn(process.execPath, args, { cwd, env: { ...process.env, CLI_AGENT_CONFIG: existsSync(join(cwd, "byok.json")) ? join(cwd, "byok.json") : undefined, ...env }, windowsHide: true, signal: AbortSignal.timeout(15000) });
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
