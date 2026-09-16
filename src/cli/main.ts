import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { getOpenAIConfig } from "../env.ts";
import { Harness } from "../harness/harness.ts";
import { streamOpenAIChat } from "../llm/openai-chat.ts";
import type { Model } from "../types.ts";
import { renderEvent } from "./render.ts";

const cwd = process.cwd();
const { apiKey, baseUrl, modelId } = getOpenAIConfig();
const model: Model = {
	id: modelId,
	name: modelId,
	provider: "openai",
	baseUrl,
	api: "openai-completions",
};

const harness = new Harness({
	cwd,
	apiKey,
	model,
	streamFn: streamOpenAIChat,
});
harness.subscribe(renderEvent);

const rl = createInterface({ input: stdin, output: stdout });
let exiting = false;

function shutdown(): void {
	exiting = true;
	rl.close();
	process.exit(0);
}

process.on("SIGINT", () => {
	if (harness.agent.state.isStreaming) {
		harness.abort();
		return;
	}
	shutdown();
});

console.log(`model=${modelId}`);
console.log(`cwd=${cwd}`);
console.log("commands: /reset  /exit");

while (!exiting) {
	let line: string;
	try {
		line = (await rl.question("you> ")).trim();
	} catch {
		break;
	}
	if (exiting) {
		break;
	}
	if (line.length === 0) {
		continue;
	}
	if (line === "/exit") {
		shutdown();
		break;
	}
	if (line === "/reset") {
		try {
			harness.reset();
			console.log("reset");
		} catch (error) {
			console.error(error instanceof Error ? error.message : error);
		}
		continue;
	}
	try {
		await harness.prompt(line);
	} catch (error) {
		console.error(error instanceof Error ? error.message : error);
	}
}
