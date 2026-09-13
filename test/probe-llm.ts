/**
 * 探针：直接打 streamOpenAIChat，不经过 Agent。
 *
 * 在 cli-agent 根目录的 `.env` 里填 OPENAI_API_KEY / OPENAI_BASE_URL / OPENAI_MODEL，
 * 然后：npx tsx test/probe-llm.ts
 */
import { Type } from "typebox";
import { getOpenAIConfig } from "../src/env.ts";
import { streamOpenAIChat } from "../src/llm/openai-chat.ts";
import type { AssistantMessageEvent, Context, Model } from "../src/types.ts";

function formatEvent(event: AssistantMessageEvent): string {
	switch (event.type) {
		case "text_delta":
			return `text_delta  ${JSON.stringify(event.delta)}`;
		case "toolcall_delta":
			return `toolcall_delta  ${JSON.stringify(event.delta)}`;
		case "toolcall_end":
			return `toolcall_end  ${event.toolCall.name} ${JSON.stringify(event.toolCall.arguments)}`;
		case "done":
			return `done  reason=${event.reason}`;
		case "error":
			return `error  reason=${event.reason}  ${event.error.errorMessage ?? ""}`;
		default:
			return event.type;
	}
}

async function runProbe(title: string, model: Model, context: Context, apiKey: string): Promise<void> {
	console.log(`\n======== ${title} ========`);
	const stream = streamOpenAIChat(model, context, { apiKey });
	for await (const event of stream) {
		console.log(formatEvent(event));
	}
	const message = await stream.result();
	console.log("result.stopReason =", message.stopReason);
	console.log("result.content =", JSON.stringify(message.content, null, 2));
	if (message.errorMessage) {
		console.log("result.errorMessage =", message.errorMessage);
	}
}

const echoTool = {
	name: "echo",
	description: "Echo a short text back. Use this when the user asks you to call a tool.",
	parameters: Type.Object({
		text: Type.String({ description: "Text to echo" }),
	}),
};

let apiKey: string;
let baseUrl: string;
let modelId: string;
try {
	({ apiKey, baseUrl, modelId } = getOpenAIConfig());
} catch (error) {
	console.error(error instanceof Error ? error.message : error);
	process.exit(1);
}
const model: Model = {
	id: modelId,
	name: modelId,
	provider: "openai",
	baseUrl,
	api: "openai-completions",
};

console.log(`model=${modelId}`);
console.log(`baseUrl=${baseUrl}`);

await runProbe(
	"1. 纯文本",
	model,
	{
		systemPrompt: "You are a test probe. Reply with exactly one character: 好",
		messages: [
			{
				role: "user",
				content: [{ type: "text", text: "只回复一个字：好" }],
				timestamp: Date.now(),
			},
		],
	},
	apiKey,
);

await runProbe(
	"2. 工具调用",
	model,
	{
		systemPrompt: "You must call the echo tool. Do not answer in plain text.",
		messages: [
			{
				role: "user",
				content: [{ type: "text", text: "用 echo 工具输出 hello" }],
				timestamp: Date.now(),
			},
		],
		tools: [echoTool],
	},
	apiKey,
);
