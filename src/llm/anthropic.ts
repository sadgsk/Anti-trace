import type { AssistantMessage, Context, ImageContent, Model, StreamFn, StreamOptions, TextContent, ThinkingContent } from "../types.ts";
import { encodeNativeThinking, resolveNativeRules } from "./rules.ts";
import { readSse } from "./sse.ts";
import type { AssistantMessageEventStream } from "./event-stream.ts";
import { appendBlock, endBlock, index, object, outputLimit, parseArguments, replayable, requestIdentity, sameSource, startBlock, streamRequest, string, tokenCount, toolIdMap, validateCapabilities, type StreamBlock, type WireObject } from "./protocol-utils.ts";

function contentBlocks(content: (TextContent | ImageContent)[]): WireObject[] {
	return content.filter(block => block.type !== "text" || block.text.length > 0).map(block => block.type === "text" ? { type: "text", text: block.text } : { type: "image", source: { type: "base64", media_type: block.mimeType, data: block.data } });
}
function thinkingBlock(value: unknown): WireObject | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return;
	const block = value as WireObject;
	if (block.type === "thinking" && typeof block.thinking === "string" && typeof block.signature === "string" && block.signature) return { type: "thinking", thinking: block.thinking, signature: block.signature };
	if (block.type === "redacted_thinking" && typeof block.data === "string" && block.data) return { type: "redacted_thinking", data: block.data };
}

function prepareAnthropicRequest(model: Model, context: Context, options?: StreamOptions) {
	if (model.api !== "anthropic-messages") throw new Error("Messages adapter 协议不匹配。");
	validateCapabilities(model, context);
	const rules = resolveNativeRules(model);
	const source = requestIdentity(model, "messages");
	const maxTokens = outputLimit(model, options, true)!;
	const thinking = encodeNativeThinking(model.api, rules, options?.thinking, maxTokens);
	const messages: Array<{ role: "user" | "assistant"; content: WireObject[] }> = [];
	const id = toolIdMap(context);
	// All tool results of a batch share one user message, before any following user text.
	const add = (role: "user" | "assistant", content: WireObject[]) => {
		if (!content.length) return;
		const previous = messages.at(-1);
		if (previous?.role === role) previous.content.push(...content);
		else messages.push({ role, content });
	};
	let continuation = context.messages.length - 1;
	while (continuation >= 0 && context.messages[continuation]!.role === "toolResult") continuation--;
	for (const [position, message] of context.messages.entries()) {
		if (message.role === "user") add("user", contentBlocks(message.content));
		else if (message.role === "toolResult") {
			const content = contentBlocks(message.content);
			add("user", [{ type: "tool_result", tool_use_id: id(message.toolCallId), is_error: message.isError, content: content.length ? content : [{ type: "text", text: "(no tool output)" }] }]);
		}
		else {
			const thoughts = message.content.filter((block): block is ThinkingContent => block.type === "thinking");
			const native = thoughts.map(block => sameSource(block.replay?.source, source) ? thinkingBlock(block.replay?.payload.block) : undefined);
			const complete = replayable(message) && native.length > 0 && native.every(Boolean);
			const sendThinking = complete && rules.reasoningReplay !== "omit";
			const hasTools = message.content.some(block => block.type === "toolCall");
			const continuingTools = position === continuation && position < context.messages.length - 1 && hasTools;
			const manualThinking = (thinking.thinking as WireObject | undefined)?.type === "enabled";
			if (options?.thinking?.enabled !== false && hasTools && (
				(rules.reasoningReplay === "required" && !complete) ||
				(continuingTools && !sendThinking && (manualThinking || thoughts.some(block => sameSource(block.replay?.source, source))))
			)) throw new Error("Anthropic 工具续接缺少当前模型／接口的完整 thinking 签名；不能使用外来或不完整的数据。");
			const content: WireObject[] = [];
			let thoughtIndex = 0;
			for (const block of message.content) {
				if (block.type === "text" && block.text) content.push({ type: "text", text: block.text });
				else if (block.type === "toolCall") content.push({ type: "tool_use", id: id(block.id), name: block.name, input: structuredClone(block.arguments) });
				else if (block.type === "thinking") {
					if (sendThinking) content.push(native[thoughtIndex]!);
					thoughtIndex++;
				}
			}
			if (continuingTools && manualThinking && !["thinking", "redacted_thinking"].includes(content[0]?.type)) throw new Error("Anthropic 预算思考的工具续接必须以完整 thinking 块开始。");
			add("assistant", content);
		}
	}
	const body: WireObject = { model: model.id, messages, stream: true, max_tokens: maxTokens, ...thinking };
	if (context.systemPrompt) body.system = context.systemPrompt;
	if (context.tools?.length) body.tools = context.tools.map(tool => ({ name: tool.name, description: tool.description, input_schema: tool.parameters }));
	const headers: Record<string, string> = { "anthropic-version": "2023-06-01" };
	if (rules.interleavedThinking && options?.thinking?.enabled !== false) headers["anthropic-beta"] = "interleaved-thinking-2025-05-14";
	return { body, source, rules, headers };
}

interface BlockState {
	block: StreamBlock;
	nativeType: string;
	closed: boolean;
	signature: string;
	data?: string;
	args: string;
	initialInput?: WireObject;
}
async function readAnthropic(body: ReadableStream<Uint8Array>, output: AssistantMessage, stream: AssistantMessageEventStream, request: ReturnType<typeof prepareAnthropicRequest>, signal?: AbortSignal): Promise<void> {
	const blocks = new Map<number, BlockState>();
	let started = false;
	let stopped = false;
	let reason: string | undefined;
	const usage: WireObject = {};
	const updateUsage = (value: unknown) => {
		if (value === undefined || value === null) return;
		const incoming = object(value, "Anthropic usage");
		for (const key of ["input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"]) {
			if (incoming[key] !== undefined && incoming[key] !== null) usage[key] = tokenCount(incoming[key]);
		}
		if (usage.input_tokens !== undefined && usage.output_tokens !== undefined) {
			// Anthropic input_tokens excludes cached input; context accounting needs the total.
			const input = usage.input_tokens + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
			output.usage = { input: tokenCount(input), output: usage.output_tokens, totalTokens: tokenCount(input + usage.output_tokens) };
		}
	};
	for await (const frame of readSse(body, signal)) {
		const event = object(JSON.parse(frame.data), "Anthropic SSE");
		if (event.type === "error" || frame.event === "error") throw new Error(`Anthropic stream error: ${event.error?.message ?? "接口返回错误"}`);
		if (event.type === "ping") continue;
		if (stopped) throw new Error("Anthropic 在 message_stop 之后继续返回数据。");
		if (event.type === "message_start") {
			if (started) throw new Error("Anthropic 重复 message_start。");
			const message = object(event.message, "message_start.message");
			if (message.role !== "assistant" || !Array.isArray(message.content) || message.content.length) throw new Error("Anthropic message_start 无效。");
			started = true;
			updateUsage(message.usage);
			continue;
		}
		if (!["content_block_start", "content_block_delta", "content_block_stop", "message_delta", "message_stop"].includes(event.type)) continue;
		if (!started) throw new Error("Anthropic 缺少 message_start。");
		if (event.type === "message_delta") {
			updateUsage(event.usage);
			if (event.delta?.stop_reason !== undefined && event.delta.stop_reason !== null) {
				const next = string(event.delta.stop_reason, "stop_reason");
				if (reason && reason !== next) throw new Error("Anthropic stop_reason 在流中变化。");
				reason = next;
				output.rawStopReason = next;
			}
			continue;
		}
		if (event.type === "message_stop") { stopped = true; continue; }
		if (reason) throw new Error("Anthropic 在 stop_reason 之后继续返回内容。");
		const position = index(event.index);
		if (event.type === "content_block_start") {
			if (blocks.has(position) || position !== blocks.size || [...blocks.values()].some(block => !block.closed)) throw new Error("Anthropic 内容块顺序无效。");
			const native = object(event.content_block, "content block");
			let block: StreamBlock;
			switch (native.type) {
				case "text": block = { type: "text", text: "" }; break;
				case "thinking":
				case "redacted_thinking": block = { type: "thinking", thinking: "" }; break;
				case "tool_use":
					block = { type: "toolCall", id: string(native.id, "tool_use.id"), name: string(native.name, "tool_use.name"), arguments: {} };
					if (!block.id || !block.name) throw new Error("Anthropic 工具缺少 ID／名称。");
					break;
				default: throw new Error(`不支持的 Anthropic 内容块：${native.type}`);
			}
			const state: BlockState = { block, nativeType: native.type, closed: false, signature: native.signature === undefined ? "" : string(native.signature, "signature"), args: "" };
			if (native.type === "redacted_thinking") state.data = string(native.data, "redacted thinking data");
			if (native.type === "tool_use") state.initialInput = object(native.input, "tool_use.input");
			blocks.set(position, state);
			startBlock(output, stream, block);
			if (native.type === "text") appendBlock(output, stream, block, string(native.text, "text"));
			if (native.type === "thinking") appendBlock(output, stream, block, string(native.thinking, "thinking"));
			continue;
		}
		const state = blocks.get(position);
		if (!state || state.closed) throw new Error("Anthropic 增量引用未知或已结束的内容块。");
		if (event.type === "content_block_stop") {
			state.closed = true;
			if (state.block.type !== "toolCall") endBlock(output, stream, state.block);
			continue;
		}
		const delta = object(event.delta, "content delta");
		if (delta.type === "text_delta" && state.nativeType === "text") appendBlock(output, stream, state.block, string(delta.text, "text delta"));
		else if (delta.type === "thinking_delta" && state.nativeType === "thinking") appendBlock(output, stream, state.block, string(delta.thinking, "thinking delta"));
		else if (delta.type === "signature_delta" && state.nativeType === "thinking") state.signature += string(delta.signature, "signature delta");
		else if (delta.type === "input_json_delta" && state.block.type === "toolCall") {
			const value = string(delta.partial_json, "工具参数增量");
			state.args += value;
			appendBlock(output, stream, state.block, value);
		} else if (delta.type !== "citations_delta") throw new Error(`Anthropic 内容块与增量类型不匹配：${delta.type}`);
	}
	signal?.throwIfAborted();
	if (!started || !stopped || !reason) throw new Error("Anthropic SSE 在完整结束状态之前结束。");
	if (reason === "max_tokens" || reason === "model_context_window_exceeded") { output.stopReason = "length"; return; }
	if (reason === "tool_use") output.stopReason = "toolUse";
	else if (["end_turn", "stop_sequence", "refusal"].includes(reason)) output.stopReason = "stop";
	else throw new Error(`Anthropic stop_reason: ${reason}`);
	if ([...blocks.values()].some(block => !block.closed)) throw new Error("Anthropic 响应含有未结束的内容块。");
	const tools = [...blocks.values()].filter(state => state.block.type === "toolCall");
	if ((reason === "tool_use") !== (tools.length > 0)) throw new Error("Anthropic 工具调用与 stop_reason 不一致。");
	const ids = new Set<string>();
	// Validate every block before committing any replay metadata or completed tool events.
	for (const state of blocks.values()) {
		if (state.block.type === "toolCall") {
			if (ids.has(state.block.id)) throw new Error("Anthropic 工具 ID 重复。");
			ids.add(state.block.id);
			if (state.args && Object.keys(state.initialInput!).length) throw new Error("Anthropic 工具同时返回非空初始参数和 JSON 增量。");
			state.block.arguments = state.args ? parseArguments(state.args) : state.initialInput!;
		} else if (state.nativeType === "thinking" && !state.signature) throw new Error("Anthropic 完整 thinking 块缺少签名。");
		else if (state.nativeType === "redacted_thinking" && !state.data) throw new Error("Anthropic redacted thinking 缺少数据。");
	}
	for (const state of blocks.values()) {
		if (state.block.type === "toolCall") endBlock(output, stream, state.block);
		if (state.block.type === "thinking") state.block.replay = { source: { ...request.source }, payload: { block: state.nativeType === "redacted_thinking" ? { type: "redacted_thinking", data: state.data! } : { type: "thinking", thinking: state.block.thinking, signature: state.signature } } };
	}
}

export const streamAnthropic: StreamFn = (model, context, options) => streamRequest(model, options, () => prepareAnthropicRequest(model, context, options), readAnthropic);
