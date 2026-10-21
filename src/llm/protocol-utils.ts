import { createHash } from "node:crypto";
import type { AssistantMessage, Context, Model, ReasoningSource, StreamOptions, TextContent, ThinkingContent, ToolCall } from "../types.ts";
import { AssistantMessageEventStream } from "./event-stream.ts";

export type WireObject = Record<string, any>;
export function object(value: unknown, label: string): WireObject {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} 必须是对象。`);
	return value as WireObject;
}
export function string(value: unknown, label: string): string {
	if (typeof value !== "string") throw new Error(`${label} 必须是字符串。`);
	return value;
}
export function index(value: unknown): number {
	if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error("流事件缺少有效 index。");
	return value as number;
}
export function parseArguments(value: string): Record<string, unknown> {
	let parsed: unknown;
	try { parsed = JSON.parse(value); } catch { throw new Error("工具参数不是完整 JSON。"); }
	return object(parsed, "工具参数");
}

export function requestIdentity(model: Model, path: string): ReasoningSource {
	const url = new URL(model.endpoint ?? `${model.baseUrl.replace(/\/+$/, "")}/${path}`);
	if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("推理地址必须是无凭据、查询参数和片段的 HTTP(S) URL。");
	return { api: model.api, provider: model.provider, model: model.id, baseUrl: url.toString() };
}
export function sameSource(left: ReasoningSource | undefined, right: ReasoningSource): boolean {
	return !!left && left.api === right.api && left.provider === right.provider && left.model === right.model && left.baseUrl === right.baseUrl;
}
export function replayable(message: AssistantMessage): boolean {
	return message.stopReason === "stop" || message.stopReason === "toolUse";
}
export function outputLimit(model: Model, options?: StreamOptions, required = false): number | undefined {
	const limit = options?.maxTokens ?? model.maxOutputTokens;
	if (limit === undefined && required) throw new Error("Anthropic Messages 需要明确设置 maxOutputTokens 或请求 maxTokens。");
	if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > model.contextWindow)) throw new Error("maxTokens 必须是正安全整数，且不能超过 contextWindow。");
	return limit;
}
export function validateCapabilities(model: Model, context: Context): void {
	if (model.capabilities?.tools === false && (context.tools?.length || context.messages.some(message => message.role === "toolResult" || message.content.some(block => block.type === "toolCall")))) throw new Error(`模型 ${model.id} 不支持工具。`);
	for (const message of context.messages) for (const block of message.content) {
		if (block.type !== "image") continue;
		if (model.capabilities?.images === false) throw new Error(`模型 ${model.id} 不支持图片。`);
		if (!["image/jpeg", "image/png", "image/gif", "image/webp"].includes(block.mimeType)) throw new Error(`不支持图片格式 ${block.mimeType}。`);
	}
}

/** Stable bijection within this request, including tool outputs imported from other protocols. */
export function toolIdMap(context: Context): (id: string) => string {
	const ids = new Set<string>();
	for (const message of context.messages) {
		if (message.role === "toolResult") ids.add(message.toolCallId);
		else for (const block of message.content) if (block.type === "toolCall") ids.add(block.id);
	}
	const mapping = new Map<string, string>();
	const used = new Set([...ids].filter(id => /^[a-zA-Z0-9_-]{1,64}$/.test(id)));
	for (const id of ids) {
		if (used.has(id)) { mapping.set(id, id); continue; }
		let candidate = `call_${createHash("sha256").update(id).digest("hex").slice(0, 40)}`;
		while (used.has(candidate)) candidate += "_";
		used.add(candidate);
		mapping.set(id, candidate);
	}
	return id => mapping.get(id) ?? id;
}

export interface PreparedRequest {
	source: ReasoningSource;
	body: WireObject;
	headers?: Record<string, string>;
	authHeader?: "api-key" | "bearer";
}

/** Shared transport/lifecycle only; each protocol owns its wire format and completion checks. */
export function streamRequest<T extends PreparedRequest>(
	model: Model, options: StreamOptions | undefined, prepare: () => T,
	read: (body: ReadableStream<Uint8Array>, output: AssistantMessage, stream: AssistantMessageEventStream, request: T, signal?: AbortSignal) => Promise<void>,
): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	const output: AssistantMessage = { role: "assistant", content: [], model: model.id, timestamp: Date.now(), stopReason: "stop" };
	void (async () => {
		try {
			options?.signal?.throwIfAborted();
			const request = prepare();
			if (!options?.apiKey?.trim()) throw new Error("No API key");
			const authHeader = request.authHeader ?? (model.api === "anthropic-messages" ? "api-key" : "bearer");
			const auth: Record<string, string> = authHeader === "api-key" ? { "x-api-key": options.apiKey } : { Authorization: `Bearer ${options.apiKey}` };
			const response = await fetch(request.source.baseUrl, {
				method: "POST", headers: { "Content-Type": "application/json", Accept: "text/event-stream", ...auth, ...request.headers },
				body: JSON.stringify(request.body), signal: options.signal,
			});
			if (!response.ok) throw new Error(`${model.api} HTTP ${response.status}: ${await response.text()}`);
			if (!response.body) throw new Error("模型响应没有 body。");
			stream.push({ type: "start", partial: output });
			await read(response.body, output, stream, request, options.signal);
			options.signal?.throwIfAborted();
			if (output.stopReason !== "stop" && output.stopReason !== "toolUse" && output.stopReason !== "length") throw new Error("协议未返回有效结束状态。");
			if (output.stopReason === "length") discardIncomplete(output);
			stream.push({ type: "done", reason: output.stopReason, message: output });
		} catch (error) {
			discardIncomplete(output);
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			const message = error instanceof Error ? error.message : String(error);
			output.errorMessage = options?.apiKey ? message.split(options.apiKey).join("[redacted]") : message;
			stream.push({ type: "error", reason: output.stopReason, error: output });
		} finally { stream.end(); }
	})();
	return stream;
}
function discardIncomplete(output: AssistantMessage): void {
	output.content = output.content.filter(block => block.type !== "toolCall");
	for (const block of output.content) if (block.type === "thinking") delete block.replay;
}

export type StreamBlock = TextContent | ThinkingContent | ToolCall;
export function startBlock(output: AssistantMessage, stream: AssistantMessageEventStream, block: StreamBlock): void {
	output.content.push(block);
	const type = block.type === "text" ? "text_start" : block.type === "thinking" ? "thinking_start" : "toolcall_start";
	stream.push({ type, contentIndex: output.content.length - 1, partial: output });
}
export function appendBlock(output: AssistantMessage, stream: AssistantMessageEventStream, block: StreamBlock, delta: string): void {
	if (block.type === "text") block.text += delta;
	else if (block.type === "thinking") block.thinking += delta;
	stream.push({ type: block.type === "text" ? "text_delta" : block.type === "thinking" ? "thinking_delta" : "toolcall_delta", contentIndex: output.content.indexOf(block), delta, partial: output });
}
export function endBlock(output: AssistantMessage, stream: AssistantMessageEventStream, block: StreamBlock): void {
	const contentIndex = output.content.indexOf(block);
	if (block.type === "toolCall") stream.push({ type: "toolcall_end", contentIndex, toolCall: block, partial: output });
	else stream.push({ type: block.type === "text" ? "text_end" : "thinking_end", contentIndex, content: block.type === "text" ? block.text : block.thinking, partial: output });
}
export function tokenCount(value: unknown): number {
	if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error("接口返回无效 usage。");
	return value as number;
}

/** Fill only the unstreamed suffix; conflicting terminal snapshots indicate a broken stream. */
export function reconcileText(current: string, final: unknown): string {
	const value = string(final, "完整内容");
	if (!value.startsWith(current)) throw new Error("流增量与完整内容不一致。");
	return value.slice(current.length);
}
