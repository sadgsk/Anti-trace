import type { ModelApi } from "../../src/types.ts";
import { chatResponse } from "./http-server.ts";

type ObjectValue = Record<string, any>;
export function nativeResponse(api: ModelApi, tools: readonly { id: string; name: string; args: Record<string, unknown> }[], answer: string): string {
	const calls = tools.length > 0;
	if (api === "openai-completions") return calls
		? `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: tools.map((tool, index) => ({ index, id: tool.id, type: "function", function: { name: tool.name, arguments: JSON.stringify(tool.args) } })) }, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`
		: chatResponse(answer);
	const events: ObjectValue[] = [];
	if (api === "openai-responses") {
		const items = calls ? tools.map(tool => ({ type: "function_call", id: `fc_${tool.id}`, call_id: tool.id, name: tool.name, arguments: JSON.stringify(tool.args), status: "completed" }))
			: [{ type: "message", id: "msg", role: "assistant", status: "completed", content: [{ type: "output_text", text: answer, annotations: [] }] }];
		events.push({ type: "response.created", response: { id: "response", status: "in_progress" } });
		items.forEach((item, output_index) => {
			events.push({ type: "response.output_item.added", output_index, item: { ...item, ...(item.type === "function_call" ? { arguments: "" } : { content: [] }) } });
			events.push({ type: "response.output_item.done", output_index, item });
		});
		events.push({ type: "response.completed", response: { id: "response", status: "completed", output: items, usage: { input_tokens: 100, output_tokens: 20 } } });
	} else {
		events.push({ type: "message_start", message: { id: "message", role: "assistant", content: [], usage: { input_tokens: 100 } } });
		const blocks = calls ? tools.map(tool => ({ type: "tool_use", id: tool.id, name: tool.name, input: tool.args })) : [{ type: "text", text: answer }];
		blocks.forEach((block, index) => { events.push({ type: "content_block_start", index, content_block: block }); events.push({ type: "content_block_stop", index }); });
		events.push({ type: "message_delta", delta: { stop_reason: calls ? "tool_use" : "end_turn" }, usage: { output_tokens: 20 } }, { type: "message_stop" });
	}
	return events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
}
