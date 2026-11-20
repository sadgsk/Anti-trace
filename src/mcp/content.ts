import type { AgentToolResult, ImageContent, TextContent } from "../types.ts";
import { detectSupportedImageMimeType } from "../harness/tools/image.ts";
import { saveMcpOutput, type McpAttachment } from "./output-store.ts";
import { McpError, type McpRequestOptions, type McpServerBinding, type McpToolResult } from "./types.ts";
import { safeText, stableJson, throwCancelled } from "./util.ts";

export interface McpContentOptions { outputDirectory: string; images?: boolean; signal?: AbortSignal }
type Progress = Parameters<NonNullable<McpRequestOptions["onProgress"]>>[0];
export interface McpResultDetails {
	kind: "mcp";
	version: 1;
	serverId: string;
	operation: string;
	status: "running" | "success" | "error";
	elapsedMs: number;
	truncated: boolean;
	attachments: McpAttachment[];
	progress?: Progress;
	errorCode?: string;
}
export interface McpDraftMaterial { text: string; images: ImageContent[]; details: McpResultDetails }

export function resultDetails(serverId: string, operation: string, started: number): McpResultDetails {
	return { kind: "mcp", version: 1, serverId, operation, status: "success", elapsedMs: Date.now() - started, truncated: false, attachments: [] };
}

export function failedResult(serverId: string, operation: string, started: number, error: unknown): AgentToolResult<McpResultDetails> {
	const details = resultDetails(serverId, operation, started);
	details.status = "error";
	const aborted = error instanceof Error && error.name === "AbortError";
	details.errorCode = error instanceof McpError ? error.code : aborted ? "cancelled" : "output";
	const reason = error instanceof McpError ? error.message + (error.code === "limit" ? " 完整结果未保存。" : "")
		: aborted ? "MCP 操作已取消。" : "MCP 结果处理或附件写入失败。";
	return { content: [{ type: "text", text: reason }], details, isError: true };
}

/** Bound UTF-8 at code point boundaries, including a split multibyte character at the end. */
function prefix(text: string, bytes: number): string {
	const buffer = Buffer.from(text);
	let end = Math.min(buffer.length, bytes);
	while (end > 0 && end < buffer.length && (buffer[end]! & 0xc0) === 0x80) end--;
	return buffer.subarray(0, end).toString("utf8");
}

function asBase64(data: string) {
	const bytes = Buffer.from(data, "base64");
	if (bytes.toString("base64") !== data) throw new McpError("protocol", "MCP 附件的 base64 编码无效。");
	return bytes;
}

function equivalentJson(text: string, encoded: string): boolean {
	try { return stableJson(JSON.parse(text)) === encoded; } catch { return false; }
}

/** Decode protocol blocks once. The unabridged text and host-generated attachment references
 * remain readable together when a bounded model result has to be saved to disk. */
export async function normalizeMcpResult(server: McpServerBinding, operation: string, response: McpToolResult,
	options: McpContentOptions, started: number): Promise<AgentToolResult<McpResultDetails>> {
	const content: (TextContent | ImageContent)[] = [];
	let textParts: string[] = [];
	const details = resultDetails(server.serverId, operation, started);
	details.status = response.isError ? "error" : "success";
	let imageBytes = 0, imageCount = 0;
	const overflowBinaries: { mimeType: string; data: string; uri?: string }[] = [];
	const addText = (text: string) => { if (text.length) textParts.push(text); };
	const flushText = () => {
		if (textParts.length) content.push({ type: "text", text: textParts.join("\n") });
		textParts = [];
	};
	const binary = async (data: string, mimeType: string, image: boolean, uri?: string) => {
		const bytes = asBase64(data);
		if (image && !bytes.length) throw new McpError("protocol", "MCP 图片内容为空。");
		const actualType = image ? detectSupportedImageMimeType(bytes) : undefined;
		if (actualType && actualType !== mimeType) throw new McpError("protocol", "MCP 图片内容与声明的 MIME 类型不一致。");
		if (actualType && options.images !== false && imageCount < 8 && imageBytes + bytes.length <= 4 * 1024 * 1024) {
			flushText();
			content.push({ type: "image", data, mimeType: actualType });
			imageBytes += bytes.length;
			imageCount++;
			return;
		}
		if (details.attachments.length >= 32) {
			overflowBinaries.push({ mimeType, data, uri });
			return;
		}
		const file = await saveMcpOutput(options.outputDirectory, bytes, mimeType, options.signal);
		details.attachments.push(file);
		addText(`[MCP attachment: ${file.mimeType}, ${file.bytes} bytes] ${file.path}`);
	};
	for (const block of response.content) {
		throwCancelled(options.signal);
		switch (block.type) {
			case "text": addText(block.text); break;
			case "audio": case "image": await binary(block.data, block.mimeType, block.type === "image"); break;
			case "resource_link":
				addText(`[MCP resource link · ${server.serverId}] ${block.name} ${block.uri}${block.mimeType ? " (" + block.mimeType + ")" : ""}`);
				break;
			case "resource": {
				const resource = block.resource;
				addText(`[MCP resource · ${server.serverId}] ${resource.uri}`);
				if ("text" in resource) addText(resource.text);
				else await binary(resource.blob, resource.mimeType ?? "application/octet-stream", resource.mimeType?.startsWith("image/") === true, resource.uri);
				break;
			}
			default: addText("Unsupported MCP content: " + safeText(String((block as { type: unknown }).type)).slice(0, 128));
		}
	}
	if (response.structuredContent !== undefined) {
		const encoded = stableJson(response.structuredContent);
		if (!response.content.some(block => block.type === "text" && equivalentJson(block.text, encoded)))
			addText(JSON.stringify(response.structuredContent, null, 2));
	}
	if (overflowBinaries.length) {
		// Persist overflow binaries together to bound the number of files per response.
		const packed = await saveMcpOutput(options.outputDirectory, JSON.stringify(overflowBinaries), "application/json", options.signal);
		details.attachments.push(packed);
		addText(`[Additional MCP binary attachments: ${overflowBinaries.length}] ${packed.path}`);
	}
	flushText();
	let remaining = server.outputMaxBytes;
	const truncated: (TextContent | ImageContent)[] = [];
	// Keep this flag visible even when the server's text budget is just one byte.
	if (response.isError) truncated.push({ type: "text", text: "[MCP tool error]" });
	for (const block of content) {
		if (block.type === "image") { truncated.push(block); continue; }
		const size = Buffer.byteLength(block.text);
		if (size > remaining) details.truncated = true;
		if (remaining > 0) truncated.push(size <= remaining ? block : { type: "text", text: prefix(block.text, remaining) });
		remaining = Math.max(0, remaining - size);
	}
	if (details.truncated) {
		const full = await saveMcpOutput(options.outputDirectory, content.filter(block => block.type === "text").map(block => block.text).join("\n"), "text/plain", options.signal);
		details.attachments.push(full);
		truncated.push({ type: "text", text: `[MCP output truncated; full text: ${full.path}]` });
	}
	throwCancelled(options.signal);
	details.elapsedMs = Date.now() - started;
	return { content: truncated, details, isError: response.isError === true };
}

export async function toDraft(result: AgentToolResult<McpResultDetails>, source: string, options: McpContentOptions, maxBytes: number): Promise<McpDraftMaterial> {
	const limit = Math.min(2048, maxBytes);
	if (Buffer.byteLength(source) > limit) {
		const file = await saveMcpOutput(options.outputDirectory, source, "text/plain", options.signal);
		source = prefix(source, limit) + `… [Complete MCP source: ${file.path}]`;
		result.details.attachments.push(file);
		result.details.truncated = true;
	}
	return {
		text: [source, ...result.content.filter(block => block.type === "text").map(block => block.text)].join("\n"),
		images: result.content.filter(block => block.type === "image"), details: result.details,
	};
}
