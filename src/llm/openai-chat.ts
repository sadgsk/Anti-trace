import { AssistantMessageEventStream } from "./event-stream.ts";
import type {
	AssistantMessage,
	Context,
	Model,
	StopReason,
	StreamFn,
	StreamOptions,
	TextContent,
	Tool,
	ToolCall,
} from "../types.ts";

function textFrom(content: Array<{ type: string; text?: string }>): string {
	return content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map((block) => block.text)
		.join("");
}

type OpenAIChatMessage =
	| { role: "system"; content: string }
	| { role: "user"; content: string }
	| {
			role: "assistant";
			content: string | null;
			tool_calls?: Array<{
				id: string;
				type: "function";
				function: { name: string; arguments: string };
			}>;
	  }
	| { role: "tool"; tool_call_id: string; content: string };

function toOpenAIMessages(context: Context): OpenAIChatMessage[] {
	const messages: OpenAIChatMessage[] = [];

	if (context.systemPrompt) {
		messages.push({ role: "system", content: context.systemPrompt });
	}

	for (const msg of context.messages) {
		if (msg.role === "user") {
			const text = textFrom(msg.content);
			if (text.length === 0) continue;
			messages.push({ role: "user", content: text });
			continue;
		}

		if (msg.role === "assistant") {
			const text = textFrom(msg.content);
			const toolCalls = msg.content.filter((block): block is ToolCall => block.type === "toolCall");
			if (text.length === 0 && toolCalls.length === 0) continue;

			const assistant: OpenAIChatMessage = {
				role: "assistant",
				content: text.length > 0 ? text : null,
			};
			if (toolCalls.length > 0) {
				assistant.tool_calls = toolCalls.map((tc) => ({
					id: tc.id,
					type: "function" as const,
					function: {
						name: tc.name,
						arguments: JSON.stringify(tc.arguments),
					},
				}));
			}
			messages.push(assistant);
			continue;
		}

		messages.push({
			role: "tool",
			tool_call_id: msg.toolCallId,
			content: textFrom(msg.content) || "(no tool output)",
		});
	}

	return messages;
}

type OpenAITool = {
	type: "function";
	function: {
		name: string;
		description: string;
		parameters: unknown;
	};
};

function toOpenAITools(tools: Tool[] | undefined): OpenAITool[] | undefined {
	if (!tools || tools.length === 0) return undefined;
	return tools.map((tool) => ({
		type: "function",
		function: {
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters,
		},
	}));
}

async function fetchChatCompletions(
	model: Model,
	messages: OpenAIChatMessage[],
	tools: OpenAITool[] | undefined,
	options?: StreamOptions,
): Promise<Response> {
	const apiKey = options?.apiKey;
	if (!apiKey) {
		throw new Error("No API key");
	}

	const url = `${model.baseUrl.replace(/\/+$/, "")}/chat/completions`;
	const body: Record<string, unknown> = {
		model: model.id,
		messages,
		stream: true,
	};
	if (tools) {
		body.tools = tools;
	}

	const response = await fetch(url, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${apiKey}`,
			"Content-Type": "application/json",
			Accept: "text/event-stream",
		},
		body: JSON.stringify(body),
		signal: options?.signal,
	});

	if (!response.ok) {
		const text = await response.text();
		throw new Error(`OpenAI HTTP ${response.status}: ${text}`);
	}
	if (!response.body) {
		throw new Error("OpenAI response has no body");
	}
	return response;
}

type DoneReason = Extract<StopReason, "stop" | "length" | "toolUse">;

interface StreamingToolCall extends ToolCall {
	partialArgs?: string;
}

function mapStopReason(reason: string): DoneReason | "error" {
	switch (reason) {
		case "stop":
		case "end":
			return "stop";
		case "length":
			return "length";
		case "function_call":
		case "tool_calls":
			return "toolUse";
		default:
			return "error";
	}
}

async function readSSE(
	body: ReadableStream<Uint8Array>,
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
): Promise<void> {
	const blocks = output.content;
	const getContentIndex = (block: (typeof blocks)[number]) => blocks.indexOf(block);
	const toolCallBlocksByIndex = new Map<number, StreamingToolCall>();
	let textBlock: TextContent | null = null;
	let hasFinishReason = false;

	const finishBlock = (block: (typeof blocks)[number]) => {
		const contentIndex = getContentIndex(block);
		if (contentIndex === -1) return;

		if (block.type === "text") {
			stream.push({
				type: "text_end",
				contentIndex,
				content: block.text,
				partial: output,
			});
			return;
		}

		if (block.type !== "toolCall") return;

		const toolBlock = block as StreamingToolCall;
		try {
			toolBlock.arguments = JSON.parse(toolBlock.partialArgs || "{}") as Record<string, unknown>;
		} catch {
			throw new Error(`Invalid tool call arguments JSON: ${toolBlock.partialArgs}`);
		}
		delete toolBlock.partialArgs;
		stream.push({
			type: "toolcall_end",
			contentIndex,
			toolCall: toolBlock,
			partial: output,
		});
	};

	const handleChunk = (raw: string) => {
		const chunk = JSON.parse(raw) as {
			choices?: Array<{
				finish_reason?: string | null;
				delta?: {
					content?: string | null;
					tool_calls?: Array<{
						index?: number;
						id?: string;
						function?: { name?: string; arguments?: string };
					}>;
				};
			}>;
		};

		const choice = chunk.choices?.[0];
		if (!choice) return;

		if (choice.finish_reason) {
			const mapped = mapStopReason(choice.finish_reason);
			if (mapped === "error") {
				throw new Error(`Provider finish_reason: ${choice.finish_reason}`);
			}
			output.stopReason = mapped;
			hasFinishReason = true;
		}

		const delta = choice.delta;
		if (!delta) return;

		if (delta.content) {
			if (!textBlock) {
				textBlock = { type: "text", text: "" };
				blocks.push(textBlock);
				stream.push({
					type: "text_start",
					contentIndex: getContentIndex(textBlock),
					partial: output,
				});
			}
			textBlock.text += delta.content;
			stream.push({
				type: "text_delta",
				contentIndex: getContentIndex(textBlock),
				delta: delta.content,
				partial: output,
			});
		}

		if (delta.tool_calls) {
			for (const toolCall of delta.tool_calls) {
				const streamIndex = toolCall.index ?? 0;
				let block = toolCallBlocksByIndex.get(streamIndex);
				if (!block) {
					block = {
						type: "toolCall",
						id: toolCall.id ?? "",
						name: toolCall.function?.name ?? "",
						arguments: {},
						partialArgs: "",
					};
					toolCallBlocksByIndex.set(streamIndex, block);
					blocks.push(block);
					stream.push({
						type: "toolcall_start",
						contentIndex: getContentIndex(block),
						partial: output,
					});
				}
				if (toolCall.id) block.id = toolCall.id;
				if (toolCall.function?.name) block.name = toolCall.function.name;
				const argsDelta = toolCall.function?.arguments ?? "";
				block.partialArgs = (block.partialArgs ?? "") + argsDelta;
				stream.push({
					type: "toolcall_delta",
					contentIndex: getContentIndex(block),
					delta: argsDelta,
					partial: output,
				});
			}
		}
	};

	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let streamFinished = false;

	try {
		while (!streamFinished) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });

			let newline = buffer.indexOf("\n");
			while (newline !== -1) {
				let line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				if (line.endsWith("\r")) line = line.slice(0, -1);

				if (line.startsWith("data:")) {
					const data = line.slice(5).trim();
					if (data === "[DONE]") {
						streamFinished = true;
						buffer = "";
						break;
					}
					if (data.length > 0) handleChunk(data);
				}

				newline = buffer.indexOf("\n");
			}
		}

		buffer += decoder.decode();
		if (buffer.startsWith("data:")) {
			const data = buffer.slice(5).trim();
			if (data.length > 0 && data !== "[DONE]") handleChunk(data);
		}
	} finally {
		reader.releaseLock();
	}

	for (const block of blocks) {
		finishBlock(block);
	}

	if (!hasFinishReason) {
		output.stopReason = blocks.some((block) => block.type === "toolCall") ? "toolUse" : "stop";
	}

	stream.push({ type: "done", reason: output.stopReason as DoneReason, message: output });
}

export const streamOpenAIChat: StreamFn = (model, context, options) => {
	const stream = new AssistantMessageEventStream();

	const output: AssistantMessage = {
		role: "assistant",
		content: [],
		model: model.id,
		stopReason: "stop",
		timestamp: Date.now(),
	};

	(async () => {
		try {
			const response = await fetchChatCompletions(
				model,
				toOpenAIMessages(context),
				toOpenAITools(context.tools),
				options,
			);
			stream.push({ type: "start", partial: output });
			await readSSE(response.body as ReadableStream<Uint8Array>, output, stream);
			stream.end();
		} catch (error) {
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = error instanceof Error ? error.message : String(error);
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
};
