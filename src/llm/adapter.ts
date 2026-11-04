import type { Model, StreamFn, ThinkingPreferences } from "../types.ts";
import { encodeChatThinking, encodeNativeThinking, resolveChatRules, resolveNativeRules } from "./rules.ts";
import { streamOpenAIChat } from "./openai-chat.ts";
import { streamOpenAIResponses } from "./openai-responses.ts";
import { streamAnthropic } from "./anthropic.ts";
import { outputLimit } from "./protocol-utils.ts";

/** One protocol boundary for ordinary requests, tool continuations and summaries. */
export const streamModel: StreamFn = (model, context, options) => {
	switch (model.api) {
		case "openai-completions": return streamOpenAIChat(model, context, options);
		case "openai-responses": return streamOpenAIResponses(model, context, options);
		case "anthropic-messages": return streamAnthropic(model, context, options);
	}
};

/** Pure preflight for user controls; encoding remains owned by the adapters. */
export function validateModelThinking(model: Model, thinking: ThinkingPreferences): void {
	const maxTokens = model.api === "anthropic-messages" ? outputLimit(model) : model.maxOutputTokens;
	if (model.api === "openai-completions") encodeChatThinking(resolveChatRules(model), thinking, maxTokens);
	else encodeNativeThinking(model.api, resolveNativeRules(model), thinking, maxTokens);
}
