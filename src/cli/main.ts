import { getOpenAIConfig } from "../env.ts";
import { Harness } from "../harness/harness.ts";
import { streamOpenAIChat } from "../llm/openai-chat.ts";
import type { Model } from "../types.ts";
import { renderEvent } from "./render.ts";

const cwd = process.cwd();
const { apiKey, baseUrl, modelId, contextWindow } = getOpenAIConfig();
const model: Model = {
	id: modelId,
	name: modelId,
	provider: "openai",
	baseUrl,
	api: "openai-completions",
	contextWindow,
};

const harness = new Harness({
	cwd,
	apiKey,
	model,
	streamFn: streamOpenAIChat,
});
harness.subscribe(renderEvent);

console.error("交互输入正在按 docs/claude-code-input-architecture.md 重建，当前 CLI 暂不可用。");
process.exitCode = 1;
