import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Only this explicit entry point can load a real configuration or contact a provider.
const args = process.argv.slice(2);
const options = new Map();
for (let i = 0; i < args.length; i += 2) {
	if (!["--config", "--model", "--max-tokens"].includes(args[i]) || !args[i + 1] || args[i + 1].startsWith("--")) {
		throw new Error("Usage: npm run test:live -- --config <path> [--model <key>] [--max-tokens <number>]");
	}
	options.set(args[i], args[i + 1]);
}
if (!options.has("--config")) throw new Error("Live tests require an explicit --config path; npm test stays offline.");
const maxTokens = Number(options.get("--max-tokens") ?? "256");
if (!Number.isSafeInteger(maxTokens) || maxTokens < 1) throw new Error("--max-tokens must be a positive integer");
const child = spawn(process.execPath, [
	"--import", new URL("../node_modules/tsx/dist/loader.mjs", import.meta.url).href,
	"--test", "--test-timeout=45000",
	fileURLToPath(new URL("../tests/live/model-smoke.live.ts", import.meta.url)),
], {
	windowsHide: true, stdio: "inherit",
	env: { ...process.env, CLI_AGENT_LIVE_CONFIG: resolve(options.get("--config")),
		CLI_AGENT_LIVE_MODEL: options.get("--model") ?? "", CLI_AGENT_LIVE_MAX_TOKENS: String(maxTokens) },
});
child.once("error", (error) => { console.error(error.message); process.exitCode = 1; });
child.once("exit", (code) => { process.exitCode = code ?? 1; });
