import type { AssistantMessage, Context, ImageContent, Model, StreamFn, StreamOptions, TextContent, ThinkingContent, ToolCall } from "../types.ts";
import { encodeNativeThinking, resolveNativeRules } from "./rules.ts";
import { readSse } from "./sse.ts";
import type { AssistantMessageEventStream } from "./event-stream.ts";
import { appendBlock, endBlock, index, object, outputLimit, parseArguments, reconcileText, replayable, requestIdentity, sameSource, startBlock, streamRequest, string, tokenCount, toolIdMap, validateCapabilities, type WireObject } from "./protocol-utils.ts";

function inputContent(content: (TextContent | ImageContent)[]): WireObject[] {
	return content.map(block => block.type === "text" ? { type: "input_text", text: block.text } : { type: "input_image", image_url: `data:${block.mimeType};base64,${block.data}`, detail: "auto" });
}
function reasoningItem(value: unknown): WireObject | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return;
	const item = value as WireObject;
	if (item.type !== "reasoning" || typeof item.id !== "string" || !item.id || typeof item.encrypted_content !== "string" || !item.encrypted_content || !Array.isArray(item.summary)) return;
	if (item.summary.some((part: any) => !part || part.type !== "summary_text" || typeof part.text !== "string")) return;
	// Only documented input fields cross the request boundary; preserve opaque bytes unchanged.
	return { type: "reasoning", id: item.id, summary: structuredClone(item.summary), encrypted_content: item.encrypted_content };
}

function prepareResponsesRequest(model: Model, context: Context, options?: StreamOptions) {
	if (model.api !== "openai-responses") throw new Error("Responses adapter 协议不匹配。");
	validateCapabilities(model, context);
	const rules = resolveNativeRules(model);
	const source = requestIdentity(model, "responses");
	const maxTokens = outputLimit(model, options);
	const id = toolIdMap(context);
	const input: WireObject[] = [];
	for (const message of context.messages) {
		if (message.role === "user") {
			if (message.content.length) input.push({ role: "user", content: inputContent(message.content) });
		} else if (message.role === "toolResult") {
			input.push({ type: "function_call_output", call_id: id(message.toolCallId), output: message.content.length ? inputContent(message.content) : "(no tool output)" });
		} else {
			const thoughts = message.content.filter((block): block is ThinkingContent => block.type === "thinking");
			const native = thoughts.map(block => sameSource(block.replay?.source, source) ? reasoningItem(block.replay?.payload.item) : undefined);
			const complete = replayable(message) && native.length > 0 && native.every(Boolean);
			if (rules.reasoningReplay === "required" && options?.thinking?.enabled !== false && message.content.some(block => block.type === "toolCall") && !complete) throw new Error("Responses 工具续接缺少同来源的完整 reasoning item。");
			let thoughtIndex = 0;
			for (const block of message.content) {
				if (block.type === "text" && block.text) input.push({ role: "assistant", content: [{ type: "output_text", text: block.text, annotations: [] }], type: "message" });
				else if (block.type === "toolCall") input.push({ type: "function_call", call_id: id(block.id), name: block.name, arguments: JSON.stringify(block.arguments) });
				else if (block.type === "thinking") {
					if (complete && rules.reasoningReplay !== "omit") input.push(native[thoughtIndex]!);
					thoughtIndex++;
				}
			}
		}
	}
	const thinking = encodeNativeThinking(model.api, rules, options?.thinking, maxTokens);
	const body: WireObject = { model: model.id, input, stream: true, store: false, include: ["reasoning.encrypted_content"], ...thinking };
	if (context.systemPrompt) body.instructions = context.systemPrompt;
	if (maxTokens !== undefined) body.max_output_tokens = maxTokens;
	if (rules.reasoningSummary && options?.thinking?.enabled !== false) body.reasoning = { ...body.reasoning, summary: rules.reasoningSummary };
	if (context.tools?.length) body.tools = context.tools.map(tool => ({ type: "function", name: tool.name, description: tool.description, parameters: tool.parameters, strict: false }));
	return { source, body, rules };
}

interface ItemState {
	id: string;
	type: "message" | "reasoning" | "function_call";
	closed: boolean;
	parts: Map<number, { block: TextContent; kind: "output_text" | "refusal"; closed: boolean }>;
	thinking?: ThinkingContent;
	summaries: Map<number, string>;
	tool?: ToolCall;
	args: string;
	native?: WireObject;
}

async function readResponses(body: ReadableStream<Uint8Array>, output: AssistantMessage, stream: AssistantMessageEventStream, request: ReturnType<typeof prepareResponsesRequest>, signal?: AbortSignal): Promise<void> {
	const items = new Map<number, ItemState>();
	let terminal = false;
	const addItem = (position: number, raw: unknown): ItemState => {
		const item = object(raw, "output item");
		if (items.has(position) || [...items.values()].some(state => state.id === item.id)) throw new Error("Responses output item 重复。");
		if (!["message", "reasoning", "function_call"].includes(item.type)) throw new Error(`不支持的 Responses output item：${item.type}`);
		const state: ItemState = { id: string(item.id, "item.id"), type: item.type, closed: false, parts: new Map(), summaries: new Map(), args: "" };
		if (!state.id) throw new Error("Responses item.id 不能为空。");
		items.set(position, state);
		if (state.type === "reasoning") {
			state.thinking = { type: "thinking", thinking: "" };
			startBlock(output, stream, state.thinking);
		} else if (state.type === "function_call") {
			state.tool = { type: "toolCall", id: string(item.call_id, "call_id"), name: string(item.name, "工具名称"), arguments: {} };
			if (!state.tool.id || !state.tool.name) throw new Error("Responses 工具缺少 call_id／名称。");
			startBlock(output, stream, state.tool);
		}
		return state;
	};
	const partFor = (state: ItemState, position: number, kind: "output_text" | "refusal") => {
		if (state.type !== "message") throw new Error("Responses 文本事件引用非 message item。");
		let part = state.parts.get(position);
		if (!part) {
			part = { block: { type: "text", text: "" }, kind, closed: false };
			state.parts.set(position, part);
			startBlock(output, stream, part.block);
		}
		if (part.kind !== kind) throw new Error("Responses 内容类型在流中变化。");
		return part;
	};
	const finishItem = (state: ItemState, raw: unknown) => {
		const item = object(raw, "完整 output item");
		if (state.id !== item.id || state.type !== item.type) throw new Error("Responses item 标识在流中变化。");
		if (state.type === "function_call") {
			if (state.tool!.id !== item.call_id || state.tool!.name !== item.name) throw new Error("Responses 工具标识在流中变化。");
			const suffix = reconcileText(state.args, item.arguments);
			if (state.closed && suffix) throw new Error("Responses 已结束的工具参数仍在变化。");
			if (suffix) appendBlock(output, stream, state.tool!, suffix);
			state.args = item.arguments;
		} else if (state.type === "reasoning") {
			if (!Array.isArray(item.summary)) throw new Error("Responses reasoning 缺少 summary。");
			const summaries = item.summary.map((part: any, i: number) => {
				if (part?.type !== "summary_text") throw new Error("Responses reasoning summary 类型无效。");
				reconcileText(state.summaries.get(i) ?? "", part.text);
				return string(part.text, "summary text");
			});
			if ([...state.summaries.keys()].some(i => i >= summaries.length)) throw new Error("Responses reasoning summary 丢失。");
			const suffix = reconcileText(state.thinking!.thinking, summaries.join("\n\n"));
			if (state.closed && suffix) throw new Error("Responses 已结束的 reasoning 仍在变化。");
			if (suffix) appendBlock(output, stream, state.thinking!, suffix);
			state.native = reasoningItem(item);
		} else {
			if (!Array.isArray(item.content)) throw new Error("Responses message 缺少 content。");
			item.content.forEach((rawPart: any, i: number) => {
				if (rawPart?.type !== "output_text" && rawPart?.type !== "refusal") throw new Error("不支持的 Responses message 内容。");
				const part = partFor(state, i, rawPart.type);
				const suffix = reconcileText(part.block.text, rawPart.type === "refusal" ? rawPart.refusal : rawPart.text);
				if (part.closed && suffix) throw new Error("Responses 已结束的文本仍在变化。");
				if (suffix) appendBlock(output, stream, part.block, suffix);
				if (!part.closed) endBlock(output, stream, part.block);
				part.closed = true;
			});
			if ([...state.parts.keys()].some(i => i >= item.content.length)) throw new Error("Responses message 内容丢失。");
		}
		if (!state.closed && state.thinking) endBlock(output, stream, state.thinking);
		state.closed = true;
	};
	for await (const frame of readSse(body, signal)) {
		if (frame.data.trim() === "[DONE]") break;
		const event = object(JSON.parse(frame.data), "Responses SSE");
		if (event.type === "error" || frame.event === "error" || event.type === "response.failed") throw new Error(`Responses stream error: ${event.error?.message ?? event.response?.error?.message ?? event.message ?? "接口返回错误"}`);
		if (terminal) throw new Error("Responses 在终止事件之后继续返回数据。");
		if (["response.completed", "response.incomplete"].includes(event.type)) {
			const response = object(event.response, "response");
			terminal = true;
			output.rawStopReason = response.incomplete_details?.reason ?? response.status;
			if (response.usage) {
				const usage = object(response.usage, "usage");
				output.usage = { input: tokenCount(usage.input_tokens), output: tokenCount(usage.output_tokens), ...(usage.total_tokens !== undefined ? { totalTokens: tokenCount(usage.total_tokens) } : {}) };
			}
			if (event.type === "response.incomplete") {
				if (response.status !== "incomplete" || response.incomplete_details?.reason !== "max_output_tokens") throw new Error(`Responses incomplete: ${response.incomplete_details?.reason ?? response.status}`);
				if (Array.isArray(response.output)) response.output.forEach((item: unknown, position: number) => finishItem(items.get(position) ?? addItem(position, item), item));
				output.stopReason = "length";
				continue;
			}
			if (response.status !== "completed" || !Array.isArray(response.output)) throw new Error("Responses completed 响应无效。");
			response.output.forEach((raw: unknown, position: number) => {
				const item = object(raw, "最终 output item");
				if (item.status !== undefined && item.status !== "completed") throw new Error("Responses completed 含有未完成的 item。");
				finishItem(items.get(position) ?? addItem(position, item), item);
			});
			if (items.size !== response.output.length) throw new Error("Responses 最终 output 缺少已接收的 item。");
			output.stopReason = [...items.values()].some(item => item.tool) ? "toolUse" : "stop";
			continue;
		}
		if (event.type === "response.output_item.added") { addItem(index(event.output_index), event.item); continue; }
		// Lifecycle/annotations and future non-content events do not affect the message.
		if (!/^response\.(?:output_item\.done|content_part\.|output_text\.|refusal\.|function_call_arguments\.|reasoning_summary_)/.test(event.type ?? "")) continue;
		const state = items.get(index(event.output_index));
		if (!state || (event.item_id !== undefined && state.id !== event.item_id)) throw new Error("Responses 增量引用未知 item。");
		if (state.closed) throw new Error("Responses 已结束的 item 收到增量。");
		if (event.type === "response.output_item.done") { finishItem(state, event.item); continue; }
		if (event.type === "response.function_call_arguments.delta" || event.type === "response.function_call_arguments.done") {
			if (!state.tool) throw new Error("Responses 参数事件引用非工具 item。");
			const delta = event.type.endsWith(".delta") ? string(event.delta, "工具参数增量") : reconcileText(state.args, event.arguments);
			state.args += delta;
			if (delta) appendBlock(output, stream, state.tool, delta);
		} else if (event.type.startsWith("response.reasoning_summary_")) {
			if (!state.thinking) throw new Error("Responses summary 事件引用非 reasoning item。");
			const position = index(event.summary_index);
			const current = state.summaries.get(position) ?? "";
			let delta = "";
			if (event.type === "response.reasoning_summary_text.delta") delta = string(event.delta, "summary delta");
			else if (event.type === "response.reasoning_summary_text.done") delta = reconcileText(current, event.text);
			else if (event.part) delta = reconcileText(current, event.part.text);
			if (!state.summaries.has(position)) {
				if (position !== state.summaries.size) throw new Error("Responses summary 顺序无效。");
				if (position) appendBlock(output, stream, state.thinking, "\n\n");
			}
			state.summaries.set(position, current + delta);
			if (delta) appendBlock(output, stream, state.thinking, delta);
		} else if (event.type.startsWith("response.output_text.") || event.type.startsWith("response.refusal.") || event.type.startsWith("response.content_part.")) {
			const kind = event.part?.type ?? (event.type.startsWith("response.refusal.") ? "refusal" : "output_text");
			if (kind !== "output_text" && kind !== "refusal") throw new Error("不支持的 Responses content part。");
			if (event.type === "response.output_text.annotation.added") continue;
			const part = partFor(state, index(event.content_index), kind);
			const final = event.part ? event.part[kind === "refusal" ? "refusal" : "text"] : event[kind === "refusal" ? "refusal" : "text"];
			const delta = event.type.endsWith(".delta") ? string(event.delta, "正文增量") : reconcileText(part.block.text, final);
			if (part.closed && delta) throw new Error("Responses 已结束的文本收到增量。");
			if (delta) appendBlock(output, stream, part.block, delta);
			if (event.type.endsWith(".done") && !part.closed) { endBlock(output, stream, part.block); part.closed = true; }
		}
	}
	signal?.throwIfAborted();
	if (!terminal) throw new Error("Responses SSE 在终止事件之前结束，响应不完整。");
	if (output.stopReason === "length") return;
	const ids = new Set<string>();
	for (const state of items.values()) {
		if (state.tool) {
			if (ids.has(state.tool.id)) throw new Error("Responses 工具 call_id 重复。");
			ids.add(state.tool.id);
			state.tool.arguments = parseArguments(state.args);
			endBlock(output, stream, state.tool);
		}
	}
	for (const state of items.values()) if (state.thinking && state.native) state.thinking.replay = { source: { ...request.source }, payload: { item: state.native } };
}

export const streamOpenAIResponses: StreamFn = (model, context, options) => streamRequest(model, options, () => prepareResponsesRequest(model, context, options), readResponses);
