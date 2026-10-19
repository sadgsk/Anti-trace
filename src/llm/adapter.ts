import type { StreamFn } from "../types.ts";
import { streamOpenAIChat } from "./openai-chat.ts";
import { streamOpenAIResponses } from "./openai-responses.ts";
import { streamAnthropic } from "./anthropic.ts";

/** One protocol boundary for ordinary requests, tool continuations and summaries. */
export const streamModel: StreamFn = (model, context, options) => {
	switch (model.api) {
		case "openai-completions": return streamOpenAIChat(model, context, options);
		case "openai-responses": return streamOpenAIResponses(model, context, options);
		case "anthropic-messages": return streamAnthropic(model, context, options);
	}
};
