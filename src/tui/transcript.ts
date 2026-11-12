import type { AgentMessage, AgentToolResult } from "../types.ts";
import type { SessionEntry } from "../harness/session.ts";
import { estimateMessagesTokens } from "../harness/context.ts";
export type NoticeTone = "info" | "success" | "warning" | "error";
export interface TextBlock { kind: "text" | "thinking"; text: string; index: number }
export interface UserTurnItem { id: number; kind: "user"; text: string; attachments: string[]; timestamp: number }
export interface AssistantTurnItem { id: number; kind: "assistant"; blocks: TextBlock[]; timestamp: number; durationMs?: number }
export interface ToolUseItem {
	id: number; kind: "tool"; callId: string; name: string; args: Record<string, unknown>;
	status: "running" | "success" | "error"; startedAt: number; endedAt?: number;
	result?: AgentToolResult; partial?: AgentToolResult;
}
export interface NoticeItem { id: number; kind: "notice"; text: string; tone: NoticeTone }
export interface CompactItem { id: number; kind: "compact"; summary: string; before: number; after: number }
export type TranscriptItem = UserTurnItem | AssistantTurnItem | ToolUseItem | NoticeItem | CompactItem;

/** Restore serializable UI data without saving UI state into the model transcript. */
export function projectMessages(messages: readonly AgentMessage[], nextId: () => number): TranscriptItem[] {
	const result: TranscriptItem[] = [];
	const tools = new Map<string, ToolUseItem>();
	for (const message of messages) {
		if (message.role === "user" && !message.isMeta) result.push({ id: nextId(), kind: "user", timestamp: message.timestamp,
			text: message.content.filter(b => b.type === "text").map(b => b.text).join("\n"),
			attachments: message.content.filter(b => b.type === "image").map((_, index) => `[Image #${index + 1}]`) });
		if (message.role === "assistant") {
			const blocks = message.content.flatMap((block, index): TextBlock[] => block.type === "text" ? [{ kind: "text", text: block.text, index }]
				: block.type === "thinking" ? [{ kind: "thinking", text: block.thinking, index }] : []);
			if (blocks.length) result.push({ id: nextId(), kind: "assistant", blocks, timestamp: message.timestamp });
			for (const block of message.content) if (block.type === "toolCall") {
				const tool: ToolUseItem = { id: nextId(), kind: "tool", callId: block.id, name: block.name, args: block.arguments,
					status: "error", startedAt: message.timestamp };
				tools.set(block.id, tool); result.push(tool);
			}
			if (message.errorMessage) result.push({ id: nextId(), kind: "notice", tone: "error", text: message.errorMessage });
		}
		if (message.role === "toolResult") {
			const tool = tools.get(message.toolCallId);
			const detail = message.details as { exitCode?: number; timedOut?: boolean } | undefined;
			if (tool) { tool.status = message.isError || detail?.timedOut || (typeof detail?.exitCode === "number" && detail.exitCode !== 0) ? "error" : "success"; tool.endedAt = message.timestamp;
				tool.result = { content: message.content, details: message.details }; }
		}
	}
	return result;
}

/** JSONL history retains the original conversation as well as compaction boundaries. */
export function projectSessionHistory(entries: readonly SessionEntry[], nextId: () => number): TranscriptItem[] {
	const result: TranscriptItem[] = [];
	let messages: AgentMessage[] = [];
	for (const entry of entries) {
		if (entry.type === "message") messages.push(entry.message);
		if (entry.type === "compaction") {
			// The raw log retains failed attempts for diagnostics; a successful recovery
			// boundary prevents that intermediate failure from reappearing on /resume.
			const last = messages.at(-1);
			if (entry.replacesError && last?.role === "assistant" && (last.errorMessage || last.stopReason === "error" || last.stopReason === "length")) messages.pop();
			result.push(...projectMessages(messages, nextId)); messages = [];
			result.push({ id: nextId(), kind: "compact", summary: entry.summary, before: entry.tokensBefore ?? 0,
				after: estimateMessagesTokens([{ role: "user", content: [{ type: "text", text: entry.summary }], timestamp: 0 }, ...entry.keptMessages]) });
		}
	}
	return [...result, ...projectMessages(messages, nextId)];
}
