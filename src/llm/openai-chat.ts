import { AssistantMessageEventStream } from "./event-stream.ts";
import { encodeChatThinking, resolveChatRules, type ChatRules } from "./rules.ts";
import { readSse } from "./sse.ts";
import { replayable, sameSource } from "./protocol-utils.ts";
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
	ThinkingContent,
	ReasoningSource,
	ThinkingPreferences,
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
	| { role: "system" | "developer"; content: string }
	| { role: "user"; content: string | OpenAIContentPart[] }
	| {
			role: "assistant";
			content: string | null;
			reasoning_content?: string;
			reasoning?: string;
			reasoning_details?: Record<string, unknown>[];
			extra_content?: { google: { thought_signature: string } };
			tool_calls?: Array<{
				id: string;
				type: "function";
				function: { name: string; arguments: string };
				extra_content?: { google: { thought_signature: string } };
			}>;
	  }
	| { role: "tool"; tool_call_id: string; content: string };

function toOpenAIMessages(context: Context, source: ReasoningSource, rules: ChatRules, thinking?: ThinkingPreferences): OpenAIChatMessage[] {
	const messages: OpenAIChatMessage[] = [];
	let lastUser = -1;
	context.messages.forEach((message, position) => { if (message.role === "user") lastUser = position; });

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
		messages.push({ role: rules.systemRole, content: context.systemPrompt });
	}

	for (const [position, msg] of context.messages.entries()) {
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
			const reasoning = reasoningForReplay(msg, source, rules);
			const details = rules.reasoningSplit ? detailsForReplay(msg, source, rules) : undefined;
			if (rules.reasoningReplay === "required" && thinking?.enabled !== false && toolCalls.length && reasoning === undefined) {
				throw new Error("工具续接缺少当前模型／接口的完整思考回传数据；不能使用外来或不完整的思考数据。");
			}
			if (text.length === 0 && toolCalls.length === 0 && reasoning === undefined) continue;

			const assistant: OpenAIChatMessage = {
				role: "assistant",
				content: text.length > 0 ? text : null,
			};
			if (details) assistant.reasoning_details = details;
			else if (reasoning !== undefined) assistant[rules.reasoningField] = reasoning;
			const signature = rules.toolSignatures === "google" && replayable(msg) ? googleSignature(msg.replay, source) : undefined;
			if (signature) assistant.extra_content = { google: { thought_signature: signature } };
			if (toolCalls.length > 0) {
				assistant.tool_calls = toolCalls.map((tc, index) => {
					const signature = rules.toolSignatures === "google" && replayable(msg) ? googleSignature(tc.replay, source) : undefined;
					if (rules.requireToolSignature && position > lastUser && index === 0 && !signature) {
						throw new Error("Gemini 工具续接缺少当前模型／接口的完整 thought_signature。");
					}
					return { id: tc.id, type: "function" as const, function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
						...(signature ? { extra_content: { google: { thought_signature: signature } } } : {}) };
				});
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

function googleSignature(replay: ToolCall["replay"], source: ReasoningSource): string | undefined {
	const value = replay?.payload.googleThoughtSignature;
	return sameSource(replay?.source, source) && typeof value === "string" && value.length > 0 ? value : undefined;
}

function detailsForReplay(message: AssistantMessage, source: ReasoningSource, rules: ChatRules): Record<string, unknown>[] | undefined {
	if (!replayable(message) || rules.reasoningReplay === "omit") return;
	for (const block of message.content) {
		if (block.type !== "thinking" || !sameSource(block.replay?.source, source)) continue;
		const details = block.replay?.payload.reasoning_details;
		if (Array.isArray(details) && details.every(item => item && typeof item === "object" && !Array.isArray(item))) {
			return structuredClone(details) as Record<string, unknown>[];
		}
	}
}

function reasoningForReplay(message: AssistantMessage, source: ReasoningSource, rules: ChatRules): string | undefined {
	if (rules.reasoningReplay === "omit" || message.stopReason === "error" || message.stopReason === "aborted" || message.stopReason === "length") return;
	const parts: string[] = [];
	for (const block of message.content) {
		if (block.type !== "thinking") continue;
		const replay = block.replay;
		// Never reconstruct a native field from only some of its reasoning segments.
		if (!replay?.source || !replay.payload || replay.source.api !== source.api || replay.source.provider !== source.provider || replay.source.model !== source.model || replay.source.baseUrl !== source.baseUrl) return;
		const value = replay.payload[rules.reasoningField];
		if (typeof value !== "string") return;
		parts.push(value);
	}
	return parts.length ? parts.join("") : undefined;
}

function chatEndpoint(model: Model): string {
	const url = new URL(model.endpoint ?? `${model.baseUrl.replace(/\/+$/, "")}/chat/completions`);
	if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
		throw new Error("Chat 推理地址必须是无凭据、查询参数和片段的 HTTP(S) URL。");
	}
	return url.toString();
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

function prepareChatRequest(model: Model, context: Context, options?: StreamOptions) {
	const rules = resolveChatRules(model);
	const url = chatEndpoint(model);
	// Store the effective inference URL as the credential-free interface identity. Different
	// endpoints under one base URL must never share replay data accidentally.
	const source: ReasoningSource = { api: model.api, provider: model.provider, model: model.id, baseUrl: url };
	const maxTokens = options?.maxTokens ?? model.maxOutputTokens;
	if (maxTokens !== undefined && (!Number.isSafeInteger(maxTokens) || maxTokens < 1 || maxTokens > model.contextWindow)) {
		throw new Error("maxTokens 必须是正安全整数，且不能超过 contextWindow。");
	}
	const thinking = encodeChatThinking(rules, options?.thinking, maxTokens);
	const body: Record<string, unknown> = {
		model: model.id,
		messages: toOpenAIMessages(context, source, rules, options?.thinking),
		stream: true,
		...thinking,
	};
	if (rules.reasoningSplit) body.reasoning_split = true;
	if (options?.thinking?.enabled === true && rules.preserveThinking && body.thinking) {
		body.thinking = { ...(body.thinking as object), ...(rules.preserveThinking === "glm" ? { clear_thinking: false } : { keep: "all" }) };
	}
	if (rules.includeUsage) body.stream_options = { include_usage: true };
	const tools = toOpenAITools(context.tools);
	if (tools) body.tools = tools;
	if (maxTokens !== undefined) body[rules.maxTokensField] = maxTokens;
	return { url, body, rules, source };
}

async function fetchChatCompletions(request: ReturnType<typeof prepareChatRequest>, options?: StreamOptions): Promise<Response> {
	const apiKey = options?.apiKey;
	if (!apiKey) throw new Error("No API key");

	const response = await fetch(request.url, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${apiKey}`,
			"Content-Type": "application/json",
			Accept: "text/event-stream",
		},
		body: JSON.stringify(request.body),
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
	pendingSignature?: string;
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
	request: ReturnType<typeof prepareChatRequest>,
	signal?: AbortSignal,
): Promise<void> {
	const blocks = output.content;
	const toolCalls = new Map<number, StreamingToolCall>();
	let active: TextContent | ThinkingContent | undefined;
	let finishReason: DoneReason | undefined;
	let messageSignature: string | undefined;
	const reasoningDetails = new Map<string, Record<string, any>>();
	const takeSignature = (value: unknown, previous?: string): string | undefined => {
		if (value === undefined) return previous;
		if (typeof value !== "string" || !value || (previous !== undefined && previous !== value)) throw new Error("Gemini thought_signature 无效或在流中变化。");
		return value;
	};

	const finishActive = () => {
		if (!active) return;
		const contentIndex = blocks.indexOf(active);
		if (active.type === "text") {
			stream.push({ type: "text_end", contentIndex, content: active.text, partial: output });
		} else {
			stream.push({ type: "thinking_end", contentIndex, content: active.thinking, partial: output });
		}
		active = undefined;
	};
	const appendText = (type: "text" | "thinking", delta: string) => {
		// An explicitly empty reasoning field is valid replay data, unlike a missing field.
		if (!delta && type === "text") return;
		if (active?.type !== type) {
			finishActive();
			active = type === "text" ? { type: "text", text: "" } : { type: "thinking", thinking: "" };
			blocks.push(active);
			stream.push({ type: type === "text" ? "text_start" : "thinking_start", contentIndex: blocks.length - 1, partial: output });
		}
		if (active.type === "text") active.text += delta;
		else active.thinking += delta;
		stream.push({ type: type === "text" ? "text_delta" : "thinking_delta", contentIndex: blocks.indexOf(active), delta, partial: output });
	};

	for await (const event of readSse(body, signal)) {
		if (event.data.trim() === "[DONE]") break;
		let chunk: ChatChunk;
		try { chunk = JSON.parse(event.data) as ChatChunk; }
		catch { throw new Error("Chat SSE 返回无效 JSON。"); }
		if (!chunk || typeof chunk !== "object" || Array.isArray(chunk)) throw new Error("Chat SSE 返回无效事件。");
		if (chunk.error || event.event === "error") {
			throw new Error(`Chat stream error: ${chunk.error?.message ?? "接口返回错误事件"}`);
		}
		// A usage-only event can follow finish_reason, and may have no choices.
		if (chunk.usage) {
			const input = chunk.usage.prompt_tokens ?? 0;
			const count = chunk.usage.completion_tokens ?? 0;
			const total = chunk.usage.total_tokens ?? undefined;
			if ([input, count, ...(total === undefined ? [] : [total])].some(value => !Number.isSafeInteger(value) || value < 0)) {
				throw new Error("Chat SSE 返回无效 usage。");
			}
			output.usage = { input, output: count, totalTokens: total };
		}
		const choice = chunk.choices?.[0];
		if (!choice) continue;
		const delta = choice.delta;
		const reasoning = delta?.[request.rules.reasoningField];
		const details = request.rules.reasoningSplit ? delta?.reasoning_details : undefined;
		if ((reasoning !== undefined && reasoning !== null && typeof reasoning !== "string") ||
			(delta?.content !== undefined && delta.content !== null && typeof delta.content !== "string")) {
			throw new Error("Chat SSE 的正文或思考增量不是字符串。");
		}
		if (finishReason && (reasoning || details?.length || delta?.extra_content || delta?.content || delta?.tool_calls?.length || choice.finish_reason)) {
			throw new Error("Chat SSE 在结束原因之后继续返回消息内容。");
		}
		if (finishReason) continue;
		if (request.rules.toolSignatures === "google") messageSignature = takeSignature(delta?.extra_content?.google?.thought_signature, messageSignature);
		if (details !== undefined && details !== null) {
			if (!Array.isArray(details)) throw new Error("MiniMax reasoning_details 必须是数组。");
			for (const [ordinal, item] of details.entries()) {
				if (!item || typeof item !== "object" || Array.isArray(item) || typeof item.text !== "string") throw new Error("MiniMax reasoning_details 条目无效。");
				const key = String(item.index ?? item.id ?? ordinal);
				const previous = reasoningDetails.get(key);
				if (previous && ["type", "id", "format"].some(field => item[field] !== undefined && previous[field] !== undefined && previous[field] !== item[field])) throw new Error("MiniMax reasoning_details 标识在流中变化。");
				reasoningDetails.set(key, { ...previous, ...item, text: (previous?.text ?? "") + item.text });
				if (typeof reasoning !== "string") appendText("thinking", item.text);
			}
		}
		if (typeof reasoning === "string") appendText("thinking", reasoning);
		if (typeof delta?.content === "string") appendText("text", delta.content);
		if (delta?.tool_calls?.length) {
			finishActive();
			for (const [ordinal, deltaTool] of delta.tool_calls.entries()) {
				const position = deltaTool.index ?? (request.rules.toolSignatures === "google" ? ordinal : undefined);
				if (!Number.isSafeInteger(position) || position! < 0) throw new Error("Chat 工具增量缺少有效 index。");
				let block = toolCalls.get(position!);
				if (!block) {
					block = { type: "toolCall", id: "", name: "", arguments: {}, partialArgs: "" };
					toolCalls.set(position!, block);
					blocks.push(block);
					stream.push({ type: "toolcall_start", contentIndex: blocks.length - 1, partial: output });
				}
				if (request.rules.toolSignatures === "google") block.pendingSignature = takeSignature(deltaTool.extra_content?.google?.thought_signature, block.pendingSignature);
				if (deltaTool.id) {
					if (block.id && block.id !== deltaTool.id) throw new Error("Chat 工具调用 ID 在流中发生变化。");
					block.id = deltaTool.id;
				}
				if (deltaTool.function?.name) block.name += deltaTool.function.name;
				const argsDelta = deltaTool.function?.arguments ?? "";
				if (typeof argsDelta !== "string") throw new Error("Chat 工具参数增量不是字符串。");
				block.partialArgs = (block.partialArgs ?? "") + argsDelta;
				stream.push({ type: "toolcall_delta", contentIndex: blocks.indexOf(block), delta: argsDelta, partial: output });
			}
		}
		if (choice.finish_reason) {
			const mapped = request.rules.toolSignatures === "google" && choice.finish_reason === "stop" && toolCalls.size ? "toolUse" : mapStopReason(choice.finish_reason);
			if (mapped === "error") throw new Error(`Provider finish_reason: ${choice.finish_reason}`);
			finishReason = mapped;
			output.stopReason = mapped;
			output.rawStopReason = choice.finish_reason;
			finishActive();
		}
	}
	signal?.throwIfAborted();
	if (!finishReason) throw new Error("Chat SSE 在 finish_reason 之前结束，响应不完整。");
	if (finishReason === "toolUse" && !toolCalls.size) throw new Error("Chat 返回 tool_calls 结束原因，但没有工具调用。");
	if (finishReason === "stop" && toolCalls.size) throw new Error("Chat 返回工具调用，但结束原因不是 tool_calls。");
	if (finishReason !== "length") {
		const ids = new Set<string>();
		for (const tool of toolCalls.values()) {
			if (!tool.id || !tool.name || ids.has(tool.id)) throw new Error("Chat 工具调用缺少 ID／名称，或 ID 重复。");
			ids.add(tool.id);
			let args: unknown;
			try { args = JSON.parse(tool.partialArgs || "{}"); }
			catch { throw new Error("Chat 工具参数不是完整 JSON。"); }
			if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("Chat 工具参数必须是 JSON 对象。");
			tool.arguments = args as Record<string, unknown>;
			delete tool.partialArgs;
			if (tool.pendingSignature) {
				tool.replay = { source: { ...request.source }, payload: { googleThoughtSignature: tool.pendingSignature } };
				delete tool.pendingSignature;
			}
			stream.push({ type: "toolcall_end", contentIndex: blocks.indexOf(tool), toolCall: tool, partial: output });
		}
		// Attach replay only after the whole stream (including trailing errors/usage) is valid.
		for (const block of blocks) {
			if (block.type === "thinking") {
				block.replay = { source: { ...request.source }, payload: { [request.rules.reasoningField]: block.thinking } };
			}
		}
		if (reasoningDetails.size) {
			const first = blocks.find((block): block is ThinkingContent => block.type === "thinking");
			if (first?.replay) first.replay.payload.reasoning_details = [...reasoningDetails.values()];
		}
		if (messageSignature) output.replay = { source: { ...request.source }, payload: { googleThoughtSignature: messageSignature } };
	} else {
		// The agent executes any ToolCall in a completed message: incomplete calls must not escape.
		for (let i = blocks.length - 1; i >= 0; i--) {
			if (blocks[i]!.type === "toolCall") blocks.splice(i, 1);
		}
	}
	stream.push({ type: "done", reason: finishReason, message: output });
}

interface ChatChunk {
	error?: { message?: string };
	usage?: { prompt_tokens?: number | null; completion_tokens?: number | null; total_tokens?: number | null } | null;
	choices?: Array<{
		finish_reason?: string | null;
		delta?: {
			content?: string | null;
			reasoning_content?: string | null;
			reasoning?: string | null;
			reasoning_details?: Array<Record<string, any>> | null;
			extra_content?: { google?: { thought_signature?: unknown } };
			tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string }; extra_content?: { google?: { thought_signature?: unknown } } }>;
		};
	}>;
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
			options?.signal?.throwIfAborted();
			const request = prepareChatRequest(model, context, options);
			const response = await fetchChatCompletions(request, options);
			stream.push({ type: "start", partial: output });
			await readSSE(response.body as ReadableStream<Uint8Array>, output, stream, request, options?.signal);
			stream.end();
		} catch (error) {
			// Calls in a failed response were never executed. Do not persist them as valid
			// assistant tool calls that would require tool results on the next user turn.
			output.content = output.content.filter(block => block.type !== "toolCall");
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = error instanceof Error ? error.message : String(error);
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
};
