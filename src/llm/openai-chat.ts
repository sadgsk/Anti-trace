import { AssistantMessageEventStream } from "./event-stream.ts";
import type {
	AssistantMessage,
	Context,
	Model,
	StopReason,
	StreamFn,
	StreamOptions,
	ImageContent,
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

type OpenAIContentPart =
	| { type: "text"; text: string }
	| { type: "image_url"; image_url: { url: string } };

/**
 * 按原顺序逐项转换，不做「先提文字、再提图片」的提取。
 * 提取会打乱同一次工具结果内部的图文交错（[文A, 图A, 文B, 图B] 会变成「文A文B」+「图A图B」）。
 */
function toContentParts(content: (TextContent | ImageContent)[]): OpenAIContentPart[] {
	return content.map((block): OpenAIContentPart =>
		block.type === "text"
			? { type: "text", text: block.text }
			: {
					type: "image_url",
					image_url: { url: `data:${block.mimeType};base64,${block.data}` },
				},
	);
}

type OpenAIChatMessage =
	| { role: "system"; content: string }
	| { role: "user"; content: string | OpenAIContentPart[] }
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

	// 一批连续的 toolResult 属于同一次 assistant 调用的应答。图片塞不进 tool 消息（OpenAI 的
	// tool content 只能是字符串），只能拆成 user 消息，但绝不能插在 assistant(tool_calls) 和
	// 它的 tool 应答之间——那样会得到 "insufficient tool messages following tool_calls message" 400。
	// 所以含图结果的正文先缓存在这里，等这批 tool 消息全部输出后再作为附件一次性发出。
	// 缓存里留整份 content 而不是只留图片：附件才能按原顺序还原图文交错，也才带得上
	// toolName / toolCallId，让模型知道哪份内容属于哪个工具调用。
	let pendingToolResults: Array<{
		toolCallId: string;
		toolName: string;
		content: (TextContent | ImageContent)[];
	}> = [];
	const flushToolResults = () => {
		if (pendingToolResults.length === 0) return;
		const content: OpenAIContentPart[] = [
			{ type: "text", text: "Tool results with images (full content below):" },
		];
		for (const result of pendingToolResults) {
			content.push({
				type: "text",
				text: `[tool result: ${result.toolName} / ${result.toolCallId}]`,
			});
			content.push(...toContentParts(result.content));
			content.push({ type: "text", text: "[/tool result]" });
		}
		messages.push({ role: "user", content });
		pendingToolResults = [];
	};

	if (context.systemPrompt) {
		messages.push({ role: "system", content: context.systemPrompt });
	}

	for (const msg of context.messages) {
		// 一批 toolResult 结束（遇到别的角色，或遍历到底）时，才把攒下的附件发出去。
		if (msg.role !== "toolResult") flushToolResults();

		if (msg.role === "user") {
			// 纯文字消息维持原行为：拼成一条字符串消息。
			if (!msg.content.some((block) => block.type === "image")) {
				const text = textFrom(msg.content);
				if (text.length === 0) continue;
				messages.push({ role: "user", content: text });
				continue;
			}
			// 有图片时按原顺序转换，保留图文交错。
			messages.push({ role: "user", content: toContentParts(msg.content) });
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

		// 纯文字工具结果维持原行为（含空结果的 "(no tool output)" 占位）。
		if (!msg.content.some((block) => block.type === "image")) {
			messages.push({
				role: "tool",
				tool_call_id: msg.toolCallId,
				content: textFrom(msg.content) || "(no tool output)",
			});
			continue;
		}

		// 含图片：tool 消息只放指引，正文（含图片）搬到这批之后的附件消息里，不重复发送整份文字。
		messages.push({
			role: "tool",
			tool_call_id: msg.toolCallId,
			content:
				"The full result of this tool call is in the attachment block after this batch of tool replies " +
				`(tool_call_id: ${msg.toolCallId}).`,
		});
		pendingToolResults.push({
			toolCallId: msg.toolCallId,
			toolName: msg.toolName,
			content: msg.content,
		});
	}

	flushToolResults();

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
	if (model.api !== "openai-completions") {
		throw new Error(`OpenAI Chat adapter does not implement '${model.api}'.`);
	}
	if (options?.thinking?.enabled !== undefined) {
		throw new Error("OpenAI Chat thinking controls are not implemented yet.");
	}
	const apiKey = options?.apiKey;
	if (!apiKey) {
		throw new Error("No API key");
	}

	const url = `${model.baseUrl.replace(/\/+$/, "")}/chat/completions`;
	const body: Record<string, unknown> = {
		model: model.id,
		messages,
		stream: true,
		// Ask for the final usage chunk; streaming omits it by default.
		stream_options: { include_usage: true },
	};
	if (tools) {
		body.tools = tools;
	}
	if (options?.maxTokens !== undefined) {
		body.max_tokens = options.maxTokens;
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
			usage?: {
				prompt_tokens?: number | null;
				completion_tokens?: number | null;
				total_tokens?: number | null;
			} | null;
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

		// Usage arrives on its own trailing chunk with an empty choices array, so it has to be
		// read before the choice check below — that early return would otherwise drop it.
		if (chunk.usage) {
			output.usage = {
				input: chunk.usage.prompt_tokens ?? 0,
				output: chunk.usage.completion_tokens ?? 0,
				totalTokens: chunk.usage.total_tokens ?? undefined,
			};
		}

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
