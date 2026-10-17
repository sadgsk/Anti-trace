import type { AssistantMessage, StreamFn } from "../types.ts";
import { AssistantMessageEventStream } from "./event-stream.ts";
import { streamOpenAIChat } from "./openai-chat.ts";

/** One protocol boundary for ordinary requests, tool continuations and summaries. */
export const streamModel: StreamFn = (model, context, options) => {
	switch (model.api) {
		case "openai-completions": return streamOpenAIChat(model, context, options);
		// 未实现的协议入口：05＋06 接入 Responses，07＋08 接入 Anthropic。
		// 对应批次将下列报错分支接为真实 StreamFn；统一入口和现有 Chat 分支保留。
		case "openai-responses":
		case "anthropic-messages": {
			const stream = new AssistantMessageEventStream();
			const error: AssistantMessage = {
				role: "assistant", content: [], model: model.id, timestamp: Date.now(), stopReason: "error",
				errorMessage: `协议 ${model.api} 尚未实现。`,
			};
			stream.push({ type: "error", reason: "error", error });
			stream.end();
			return stream;
		}
	}
};
