import type { Readable, Writable } from "node:stream";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadByokConfig } from "../config/byok.ts";
import { Harness } from "../harness/harness.ts";
import { streamModel } from "../llm/adapter.ts";
import type { TerminalStreams } from "./ink/terminal-host.ts";
import { createPromptDraft } from "./input/prompt-draft.ts";
import { ReplController, type ReplHarness } from "./repl/repl-controller.ts";
import { startTerminalRepl } from "./repl/terminal-repl.tsx";

export interface CliStreams {
	stdin: Readable & { isTTY?: boolean };
	stdout: Writable & { isTTY?: boolean; columns?: number };
	stderr: Writable;
}
export interface RunCliOptions {
	harness?: ReplHarness;
	streams?: CliStreams;
	cwd?: string;
	sessionsRoot?: string;
	configPath?: string;
	model?: string;
}

/** TTY runs the editor; a pipe is one complete message, including all of its newlines. */
export async function runCli(options: RunCliOptions = {}): Promise<number> {
	const streams = options.streams ?? { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr };
	const cwd = options.cwd ?? process.cwd();
	let harness = options.harness;
	let modelName = "CLI Agent";
	if (!harness) {
		const config = loadByokConfig({ cwd, configPath: options.configPath, model: options.model });
		if (config.model.api !== "openai-completions") {
			throw new Error(`当前模型 ${config.currentModel} 使用 ${config.model.api}，该协议尚未实现。`);
		}
		harness = new Harness({
			cwd, apiKey: config.getApiKey(), model: config.model, thinking: config.thinking,
			streamFn: streamModel, sessionsRoot: options.sessionsRoot,
		});
		modelName = config.model.name;
	}
	if (streams.stdin.isTTY && streams.stdout.isTTY) {
		const terminal = startTerminalRepl({ harness, streams: streams as unknown as TerminalStreams, banner: `${modelName} · ${cwd}` });
		await terminal.done;
		return 0;
	}
	if (streams.stdin.isTTY) {
		streams.stderr.write("交互输入需要 TTY 输出；请在终端运行，或通过管道提供完整输入。\n");
		return 1;
	}
	return runPipe(harness, streams);
}

async function runPipe(harness: ReplHarness, streams: CliStreams): Promise<number> {
	const repl = new ReplController({ harness });
	let printedEntries = 0;
	let printedLive = 0;
	let livePrefix = "";
	const unsubscribe = repl.subscribe(() => {
		const state = repl.getSnapshot();
		for (const entry of state.entries.slice(printedEntries)) {
			if (entry.kind === "user") continue;
			const text = livePrefix && entry.text.startsWith(livePrefix) ? entry.text.slice(livePrefix.length) : entry.text;
			streams.stdout.write(`${text}\n`);
			livePrefix = "";
			printedLive = 0;
		}
		printedEntries = state.entries.length;
		if (state.liveText.length > printedLive) {
			streams.stdout.write(state.liveText.slice(printedLive));
			printedLive = state.liveText.length;
			livePrefix = state.liveText;
		}
		if (!state.liveText) printedLive = 0;
	});
	let signalCode = 0;
	const interrupt = (code: number) => {
		signalCode = code;
		repl.exit();
		streams.stdin.destroy();
	};
	const onSigint = () => interrupt(130);
	const onSigterm = () => interrupt(143);
	process.once("SIGINT", onSigint);
	process.once("SIGTERM", onSigterm);
	try {
		const buffers: Buffer[] = [];
		for await (const chunk of streams.stdin) buffers.push(Buffer.from(chunk));
		if (signalCode) return signalCode;
		const text = Buffer.concat(buffers).toString("utf8");
		if (!text.trim()) return 0;
		await repl.submit(createPromptDraft(text));
		return signalCode || (repl.getSnapshot().error ? 1 : 0);
	} catch (error) {
		if (signalCode) return signalCode;
		streams.stderr.write(`错误：${error instanceof Error ? error.message : String(error)}\n`);
		return 1;
	} finally {
		process.off("SIGINT", onSigint);
		process.off("SIGTERM", onSigterm);
		unsubscribe();
		repl.dispose();
	}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	void runCli().then(code => { process.exitCode = code; }).catch(error => {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	});
}
