import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { Agent } from "../agent/agent.ts";
import { getOpenAIConfig } from "../env.ts";
import { streamOpenAIChat } from "../llm/openai-chat.ts";
import { buildSystemPrompt } from "../prompt.ts";
import { createBashTool } from "../tools/bash.ts";
import type { Model } from "../types.ts";
import { renderEvent } from "./render.ts";

const cwd = process.cwd();
const { apiKey, baseUrl, modelId } = getOpenAIConfig();
const bash = createBashTool(cwd);
const model: Model = {
	id: modelId,
	name: modelId,
	provider: "openai",
	baseUrl,
	api: "openai-completions",
};

const agent = new Agent({
	streamFn: streamOpenAIChat,
	apiKey,
	initialState: {
		systemPrompt: buildSystemPrompt({ cwd, toolNames: [bash.name] }),
		model,
		tools: [bash],
	},
});
agent.subscribe(renderEvent);

const rl = createInterface({ input: stdin, output: stdout });
let exiting = false;

function shutdown(): void {
	exiting = true;
	rl.close();
	process.exit(0);
}

process.on("SIGINT", () => {
	if (agent.state.isStreaming) {
		agent.abort();
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
			agent.reset();
			console.log("reset");
		} catch (error) {
			console.error(error instanceof Error ? error.message : error);
		}
		continue;
	}
	try {
		await agent.prompt(line);
	} catch (error) {
		console.error(error instanceof Error ? error.message : error);
	}
}
