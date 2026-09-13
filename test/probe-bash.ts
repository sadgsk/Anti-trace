/**
 * 探针：直接调 bash 工具的 execute，不经过 Agent / LLM。
 *
 * 在 cli-agent 根目录：npx tsx test/probe-bash.ts
 */
import { createBashTool } from "../src/tools/bash.ts";

const tool = createBashTool(process.cwd());
let failed = 0;

function textOf(result: { content: { type: string; text?: string }[] }): string {
	return result.content
		.filter((block) => block.type === "text")
		.map((block) => block.text ?? "")
		.join("");
}

async function runCase(title: string, fn: () => Promise<void>): Promise<void> {
	console.log(`\n======== ${title} ========`);
	try {
		await fn();
		console.log("PASS");
	} catch (error) {
		failed += 1;
		console.error("FAIL", error instanceof Error ? error.message : error);
	}
}

await runCase("1. echo hello 返回文本", async () => {
	const result = await tool.execute("probe-echo", { command: "echo hello" });
	const text = textOf(result);
	console.log("text =", JSON.stringify(text));
	console.log("details =", result.details);
	if (!text.toLowerCase().includes("hello")) {
		throw new Error(`expected output to contain hello, got ${JSON.stringify(text)}`);
	}
	if (result.details.exitCode !== 0) {
		throw new Error(`expected exitCode 0, got ${result.details.exitCode}`);
	}
});

await runCase("2. 非 0 退出码返回文本，不抛错", async () => {
	const result = await tool.execute("probe-exit", { command: "exit 1" });
	const text = textOf(result);
	console.log("text =", JSON.stringify(text));
	console.log("details =", result.details);
	if (result.details.exitCode !== 1) {
		throw new Error(`expected exitCode 1, got ${result.details.exitCode}`);
	}
	if (!text.includes("exited with code 1")) {
		throw new Error(`expected exit-code suffix, got ${JSON.stringify(text)}`);
	}
});

await runCase("3. abort 会 throw", async () => {
	const controller = new AbortController();
	const hang = process.platform === "win32" ? "ping -n 20 127.0.0.1" : "sleep 20";
	const pending = tool.execute("probe-abort", { command: hang }, controller.signal);
	setTimeout(() => controller.abort(), 200);
	try {
		await pending;
		throw new Error("expected execute to throw when aborted");
	} catch (error) {
		if (!(error instanceof Error) || error.message !== "Command aborted") {
			throw error;
		}
		console.log("threw =", error.message);
	}
});

if (failed > 0) {
	console.error(`\n${failed} case(s) failed`);
	process.exit(1);
}
console.log("\nall cases passed");
