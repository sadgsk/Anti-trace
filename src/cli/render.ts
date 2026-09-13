import type { AgentEvent, AgentMessage, AgentToolResult } from "../types.ts";

let wroteText = false;

function previewToolResult(result: unknown): string {
	if (!result || typeof result !== "object" || !("content" in result)) {
		return "";
	}
	const content = (result as AgentToolResult).content;
	if (!Array.isArray(content)) {
		return "";
	}
	const text = content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map((block) => block.text)
		.join("")
		.replace(/\s+/g, " ")
		.trim();
	if (text.length <= 80) {
		return text;
	}
	return `${text.slice(0, 80)}...`;
}

function lastAssistant(messages: AgentMessage[]): Extract<AgentMessage, { role: "assistant" }> | undefined {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message?.role === "assistant") {
			return message;
		}
	}
	return undefined;
}

export function renderEvent(event: AgentEvent): void {
	switch (event.type) {
		case "message_update":
			if (event.assistantMessageEvent.type === "text_delta") {
				process.stdout.write(event.assistantMessageEvent.delta);
				wroteText = true;
			}
			break;

		case "tool_execution_start":
			process.stdout.write(`\n[${event.toolName}] running\n`);
			wroteText = false;
			break;

		case "tool_execution_end": {
			const status = event.isError ? "error" : "ok";
			const preview = previewToolResult(event.result);
			process.stdout.write(preview ? `[${event.toolName}] ${status}: ${preview}\n` : `[${event.toolName}] ${status}\n`);
			break;
		}

		case "turn_end":
			if (wroteText) {
				process.stdout.write("\n");
				wroteText = false;
			}
			break;

		case "agent_end": {
			const assistant = lastAssistant(event.messages);
			if (
				assistant &&
				(assistant.stopReason === "error" || assistant.stopReason === "aborted" || assistant.errorMessage)
			) {
				console.error(assistant.errorMessage ?? assistant.stopReason);
			}
			break;
		}
	}
}
