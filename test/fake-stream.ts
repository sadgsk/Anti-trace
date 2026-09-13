/**
 * 测试替身：按脚本回合假装成 StreamFn。不要放进 src/，产品路径只接真模型。
 */
import { AssistantMessageEventStream } from "../src/llm/event-stream.ts";
import type { AssistantMessage, StopReason, StreamFn, ToolCall } from "../src/types.ts";

export type FakeStreamTurn =
	| {
			text?: string;
			toolCalls?: Array<{
				id: string;
				name: string;
				arguments: Record<string, unknown>;
			}>;
			stopReason?: Extract<StopReason, "stop" | "length" | "toolUse">;
	  }
	| {
			error: string;
			stopReason?: Extract<StopReason, "error" | "aborted">;
	  };

export function createFakeStreamFn(turns: readonly FakeStreamTurn[]): StreamFn {
	const queue = [...turns];

	return (model, _context, options) => {
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
				if (options?.signal?.aborted) {
					output.stopReason = "aborted";
					output.errorMessage = "aborted";
					stream.push({ type: "error", reason: "aborted", error: output });
					stream.end();
					return;
				}

				const turn = queue.shift();
				if (turn === undefined) {
					output.stopReason = "error";
					output.errorMessage = "Fake stream exhausted: no scripted turn left";
					stream.push({ type: "error", reason: "error", error: output });
					stream.end();
					return;
				}

				if ("error" in turn) {
					output.stopReason = turn.stopReason ?? "error";
					output.errorMessage = turn.error;
					stream.push({ type: "error", reason: output.stopReason, error: output });
					stream.end();
					return;
				}

				if (turn.text !== undefined) {
					output.content.push({ type: "text", text: turn.text });
				}

				const toolCalls: ToolCall[] = (turn.toolCalls ?? []).map((toolCall) => ({
					type: "toolCall",
					id: toolCall.id,
					name: toolCall.name,
					arguments: toolCall.arguments,
				}));
				output.content.push(...toolCalls);

				output.stopReason =
					turn.stopReason ?? (toolCalls.length > 0 ? "toolUse" : "stop");

				stream.push({ type: "start", partial: output });

				let contentIndex = 0;
				if (turn.text !== undefined) {
					stream.push({ type: "text_start", contentIndex, partial: output });
					stream.push({
						type: "text_delta",
						contentIndex,
						delta: turn.text,
						partial: output,
					});
					stream.push({
						type: "text_end",
						contentIndex,
						content: turn.text,
						partial: output,
					});
					contentIndex += 1;
				}

				for (const toolCall of toolCalls) {
					const delta = JSON.stringify(toolCall.arguments);
					stream.push({ type: "toolcall_start", contentIndex, partial: output });
					stream.push({
						type: "toolcall_delta",
						contentIndex,
						delta,
						partial: output,
					});
					stream.push({
						type: "toolcall_end",
						contentIndex,
						toolCall,
						partial: output,
					});
					contentIndex += 1;
				}

				stream.push({
					type: "done",
					reason: output.stopReason,
					message: output,
				});
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
}
