/**
 * Agent loop that works with AgentMessage throughout.
 * Transforms to Message[] only at the LLM call boundary.
 */

import { Check } from "typebox/value";
import type {
	AgentContext,
	AgentEventSink,
	AgentLoopConfig,
	AgentMessage,
	AgentTool,
	AgentToolCall,
	AgentToolResult,
	AssistantMessage,
	Context,
	StreamFn,
	ToolResultMessage,
	UserMessage,
} from "../types.ts";

type ExecutedToolCallBatch = {
	messages: ToolResultMessage[];
	newMessages?: UserMessage[];
	terminate: boolean;
};

export async function runAgentLoop(
	prompts: AgentMessage[],
	context: AgentContext,
	config: AgentLoopConfig,
	emit: AgentEventSink,
	signal: AbortSignal | undefined,
	streamFn: StreamFn,
): Promise<AgentMessage[]> {
	const newMessages: AgentMessage[] = [...prompts];
	const currentContext: AgentContext = {
		...context,
		messages: [...context.messages, ...prompts],
	};

	await emit({ type: "agent_start" });
	await emit({ type: "turn_start" });
	for (const prompt of prompts) {
		await emit({ type: "message_start", message: prompt });
		await emit({ type: "message_end", message: prompt });
	}

	await runLoop(currentContext, newMessages, config, signal, emit, streamFn);
	return newMessages;
}

async function runLoop(
	initialContext: AgentContext,
	newMessages: AgentMessage[],
	initialConfig: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
	streamFn: StreamFn,
): Promise<void> {
	let currentContext = initialContext;
	let config = initialConfig;
	let firstTurn = true;

	while (true) {
		if (!firstTurn) {
			await emit({ type: "turn_start" });
		} else {
			firstTurn = false;
		}

		signal?.throwIfAborted();
		if (config.beforeModelRequest) {
			currentContext = await config.beforeModelRequest({
				context: currentContext, model: structuredClone(config.model),
				thinking: config.thinking ? { ...config.thinking } : undefined,
				maxTokens: config.maxTokens ?? config.model.maxOutputTokens,
				apiKey: config.apiKey, getApiKey: config.getApiKey,
			}, signal) ?? currentContext;
		}
		signal?.throwIfAborted();
		const message = await streamAssistantResponse(currentContext, config, signal, emit, streamFn);
		newMessages.push(message);

		const toolCalls = message.content.filter((block) => block.type === "toolCall");
		if (message.stopReason === "error" || message.stopReason === "aborted") {
			const unexecuted = await failUnexecutedToolCalls(toolCalls, emit, name =>
				`Tool call "${name}" was not executed: the model response ended with ${message.stopReason}.`);
			newMessages.push(...unexecuted.messages);
			await emit({ type: "turn_end", message, toolResults: unexecuted.messages });
			await emit({ type: "agent_end", messages: newMessages });
			return;
		}

		const toolResults: ToolResultMessage[] = [];
		let hasMoreToolCalls = false;

		if (toolCalls.length > 0) {
			const executedToolBatch: ExecutedToolCallBatch =
				message.stopReason === "length"
					? await failUnexecutedToolCalls(toolCalls, emit, name =>
							`Tool call "${name}" was not executed: the response hit the output token limit, so its arguments may be truncated. Re-issue the tool call with complete arguments.`)
					: await executeToolCallsSequential(
							currentContext,
							message,
							toolCalls,
							config,
							signal,
							emit,
						);
			toolResults.push(...executedToolBatch.messages);
			hasMoreToolCalls = !executedToolBatch.terminate;

			for (const result of toolResults) {
				currentContext.messages.push(result);
				newMessages.push(result);
			}
			// All tool results must precede injected context in Chat, Responses and Messages.
			if (!signal?.aborted) for (const injected of executedToolBatch.newMessages ?? []) {
				currentContext.messages.push(injected);
				newMessages.push(injected);
				await emit({ type: "message_start", message: injected });
				await emit({ type: "message_end", message: injected });
			}
		}

		await emit({ type: "turn_end", message, toolResults });

		const nextTurnContext = {
			message,
			toolResults,
			context: currentContext,
			newMessages,
		};
		const nextTurnSnapshot = await config.prepareNextTurn?.(nextTurnContext);
		if (nextTurnSnapshot) {
			currentContext = nextTurnSnapshot.context ?? currentContext;
			config = {
				...config,
				model: nextTurnSnapshot.model ? structuredClone(nextTurnSnapshot.model) : config.model,
				thinking: nextTurnSnapshot.thinking ? { ...nextTurnSnapshot.thinking } : config.thinking,
			};
		}

		if (
			await config.shouldStopAfterTurn?.({
				message,
				toolResults,
				context: currentContext,
				newMessages,
			})
		) {
			await emit({ type: "agent_end", messages: newMessages });
			return;
		}

		// Steering is consumed only after every call has a paired result. A plain
		// final answer has the same boundary as a tool batch.
		const terminated = toolCalls.length > 0 && !hasMoreToolCalls;
		const steering = !terminated && !signal?.aborted ? await config.getSteeringMessages?.() ?? [] : [];
		for (const user of steering) {
			currentContext.messages.push(user);
			newMessages.push(user);
			await emit({ type: "message_start", message: user });
			await emit({ type: "message_end", message: user });
		}
		if ((!hasMoreToolCalls && !steering.length) || signal?.aborted) {
			await emit({ type: "agent_end", messages: newMessages });
			return;
		}
	}
}

async function streamAssistantResponse(
	context: AgentContext,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
	streamFn: StreamFn,
): Promise<AssistantMessage> {
	let messages = context.messages;
	if (config.transformContext) {
		messages = await config.transformContext(messages, signal);
	}

	const llmMessages = await config.convertToLlm(messages);
	const llmContext: Context = {
		systemPrompt: context.systemPrompt,
		messages: llmMessages,
		tools: context.tools,
	};
	const resolvedApiKey =
		config.getApiKey ? await config.getApiKey(config.model.provider, config.model) : config.apiKey;
	signal?.throwIfAborted();
	const response = await streamFn(config.model, llmContext, {
		apiKey: resolvedApiKey,
		signal,
		maxTokens: config.maxTokens ?? config.model.maxOutputTokens,
		thinking: config.thinking ? { ...config.thinking } : undefined,
	});

	let partialMessage: AssistantMessage | null = null;
	let addedPartial = false;

	for await (const event of response) {
		switch (event.type) {
			case "start":
				partialMessage = event.partial;
				context.messages.push(partialMessage);
				addedPartial = true;
				await emit({ type: "message_start", message: { ...partialMessage } });
				break;

			case "text_start":
			case "text_delta":
			case "text_end":
			case "thinking_start":
			case "thinking_delta":
			case "thinking_end":
			case "toolcall_start":
			case "toolcall_delta":
			case "toolcall_end":
				if (partialMessage) {
					partialMessage = event.partial;
					context.messages[context.messages.length - 1] = partialMessage;
					await emit({
						type: "message_update",
						assistantMessageEvent: event,
						message: { ...partialMessage },
					});
				}
				break;

			case "done":
			case "error": {
				const finalMessage = await response.result();
				if (addedPartial) {
					context.messages[context.messages.length - 1] = finalMessage;
				} else {
					context.messages.push(finalMessage);
				}
				if (!addedPartial) {
					await emit({ type: "message_start", message: { ...finalMessage } });
				}
				await emit({ type: "message_end", message: finalMessage });
				return finalMessage;
			}
		}
	}

	const finalMessage = await response.result();
	if (addedPartial) {
		context.messages[context.messages.length - 1] = finalMessage;
	} else {
		context.messages.push(finalMessage);
		await emit({ type: "message_start", message: { ...finalMessage } });
	}
	await emit({ type: "message_end", message: finalMessage });
	return finalMessage;
}

async function failUnexecutedToolCalls(
	toolCalls: AgentToolCall[],
	emit: AgentEventSink,
	reason: (toolName: string) => string,
): Promise<ExecutedToolCallBatch> {
	const messages: ToolResultMessage[] = [];
	for (const toolCall of toolCalls) {
		await emit({
			type: "tool_execution_start",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			args: toolCall.arguments,
		});
		const finalized: FinalizedToolCallOutcome = {
			toolCall,
			result: createErrorToolResult(reason(toolCall.name)),
			isError: true,
		};
		await emitToolExecutionEnd(finalized, emit);
		const toolResultMessage = createToolResultMessage(finalized);
		await emitToolResultMessage(toolResultMessage, emit);
		messages.push(toolResultMessage);
	}
	return { messages, terminate: false };
}

async function executeToolCallsSequential(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	toolCalls: AgentToolCall[],
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ExecutedToolCallBatch> {
	const finalizedCalls: FinalizedToolCallOutcome[] = [];
	const messages: ToolResultMessage[] = [];

	for (const toolCall of toolCalls) {
		await emit({
			type: "tool_execution_start",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			args: toolCall.arguments,
		});

		const preparation = await prepareToolCall(currentContext, assistantMessage, toolCall, config, signal);
		let finalized: FinalizedToolCallOutcome;
		if (preparation.kind === "immediate") {
			finalized = {
				toolCall,
				result: preparation.result,
				isError: preparation.isError,
			};
		} else {
			const executed = await executePreparedToolCall(preparation, signal, emit);
			finalized = await finalizeExecutedToolCall(
				currentContext,
				assistantMessage,
				preparation,
				executed,
				config,
				signal,
			);
		}

		await emitToolExecutionEnd(finalized, emit);
		const toolResultMessage = createToolResultMessage(finalized);
		await emitToolResultMessage(toolResultMessage, emit);
		finalizedCalls.push(finalized);
		messages.push(toolResultMessage);

		// Complete the batch with aborted results so every model call retains a paired result.
	}

	return {
		messages,
		newMessages: finalizedCalls.flatMap(call => call.isError ? [] : call.result.newMessages ?? []),
		terminate: shouldTerminateToolBatch(finalizedCalls),
	};
}

type PreparedToolCall = {
	kind: "prepared";
	toolCall: AgentToolCall;
	tool: AgentTool;
	reservation?: Awaited<ReturnType<NonNullable<AgentTool["acquireExecution"]>>>;
	args: unknown;
};

type ImmediateToolCallOutcome = {
	kind: "immediate";
	result: AgentToolResult;
	isError: boolean;
};

type ExecutedToolCallOutcome = {
	result: AgentToolResult;
	isError: boolean;
};

type FinalizedToolCallOutcome = {
	toolCall: AgentToolCall;
	result: AgentToolResult;
	isError: boolean;
};

function shouldTerminateToolBatch(finalizedCalls: FinalizedToolCallOutcome[]): boolean {
	return finalizedCalls.length > 0 && finalizedCalls.every((finalized) => finalized.result.terminate === true);
}

function validateToolArguments(tool: AgentTool, toolCall: AgentToolCall): unknown {
	if (!Check(tool.parameters, toolCall.arguments)) {
		throw new Error(
			`Validation failed for tool "${toolCall.name}":\nReceived arguments:\n${JSON.stringify(toolCall.arguments, null, 2)}`,
		);
	}
	return toolCall.arguments;
}

function prepareToolCallArguments(tool: AgentTool, toolCall: AgentToolCall): AgentToolCall {
	if (!tool.prepareArguments) {
		return toolCall;
	}
	const preparedArguments = tool.prepareArguments(toolCall.arguments);
	if (preparedArguments === toolCall.arguments) {
		return toolCall;
	}
	return {
		...toolCall,
		arguments: preparedArguments as Record<string, unknown>,
	};
}

async function prepareToolCall(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	toolCall: AgentToolCall,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
): Promise<PreparedToolCall | ImmediateToolCallOutcome> {
	if (signal?.aborted) return { kind: "immediate", result: createErrorToolResult("Operation aborted"), isError: true };
	const tool = currentContext.tools?.find((candidate) => candidate.name === toolCall.name);
	if (!tool) {
		return {
			kind: "immediate",
			result: createErrorToolResult(`Tool ${toolCall.name} not found`),
			isError: true,
		};
	}

	let reservation: PreparedToolCall["reservation"];
	try {
		const preparedToolCall = prepareToolCallArguments(tool, toolCall);
		const validatedArgs = validateToolArguments(tool, preparedToolCall);
		const permission = tool.resolvePermission?.(validatedArgs);
		if (permission && !config.beforeToolCall) {
			return { kind: "immediate", result: createErrorToolResult("此工具需要授权，当前入口未配置审批处理程序。"), isError: true };
		}
		if (config.beforeToolCall) {
			const acquire = tool.acquireExecution;
			const reserveForApproval = acquire && (async (approvalSignal: AbortSignal) => {
				if (reservation) return; // Composed permission hooks share this call's reservation.
				const linked = signal ? AbortSignal.any([signal, approvalSignal]) : approvalSignal;
				const held = await acquire(validatedArgs, linked);
				if (linked.aborted) { held.release(); linked.throwIfAborted(); }
				reservation = held;
			});
			const beforeResult = await config.beforeToolCall(
				{
					reserveForApproval,
					assistantMessage,
					toolCall,
					args: validatedArgs,
					permission,
					context: currentContext,
				},
				signal,
			);
			if (signal?.aborted) {
				return {
					kind: "immediate",
					result: createErrorToolResult("Operation aborted"),
					isError: true,
				};
			}
			if (beforeResult?.block) {
				const result = createErrorToolResult(beforeResult.reason || "Tool execution was blocked");
				if (beforeResult.terminate === true) {
					result.terminate = true;
				}
				return {
					kind: "immediate",
					result,
					isError: true,
				};
			}
		}
		if (signal?.aborted) {
			return {
				kind: "immediate",
				result: createErrorToolResult("Operation aborted"),
				isError: true,
			};
		}
		const prepared: PreparedToolCall = {
			kind: "prepared",
			toolCall,
			tool,
			reservation,
			args: validatedArgs,
		};
		reservation = undefined; // The executor now owns the reservation.
		return prepared;
	} catch (error) {
		return {
			kind: "immediate",
			result: createErrorToolResult(error instanceof Error ? error.message : String(error)),
			isError: true,
		};
	} finally {
		reservation?.release();
	}
}

async function executePreparedToolCall(
	prepared: PreparedToolCall,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ExecutedToolCallOutcome> {
	const updateEvents: Promise<void>[] = [];
	let acceptingUpdates = true;

	try {
		const result = await (prepared.reservation ?? prepared.tool).execute(
			prepared.toolCall.id,
			prepared.args as never,
			signal,
			(partialResult) => {
				if (!acceptingUpdates) return;
				updateEvents.push(
					Promise.resolve(
						emit({
							type: "tool_execution_update",
							toolCallId: prepared.toolCall.id,
							toolName: prepared.toolCall.name,
							args: prepared.toolCall.arguments,
							partialResult,
						}),
					),
				);
			},
		);
		acceptingUpdates = false;
		await Promise.all(updateEvents);
		if (signal?.aborted && result.isError) {
			return { isError: true, result: { ...result,
				content: [...result.content, { type: "text", text: "执行结果未知，继续前请核对。" }] } };
		}
		return { result, isError: result.isError === true };
	} catch (error) {
		acceptingUpdates = false;
		await Promise.all(updateEvents);
		const reason = error instanceof Error ? error.message : String(error);
		return {
			result: createErrorToolResult(signal?.aborted ? `${reason}（执行结果未知，继续前请核对。）` : reason),
			isError: true,
		};
	} finally {
		acceptingUpdates = false;
		prepared.reservation?.release();
	}
}

async function finalizeExecutedToolCall(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	prepared: PreparedToolCall,
	executed: ExecutedToolCallOutcome,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
): Promise<FinalizedToolCallOutcome> {
	let result = executed.result;
	let isError = executed.isError;

	if (config.afterToolCall) {
		try {
			const afterResult = await config.afterToolCall(
				{
					assistantMessage,
					toolCall: prepared.toolCall,
					args: prepared.args,
					result,
					isError,
					context: currentContext,
				},
				signal,
			);
			if (afterResult) {
				isError = afterResult.isError ?? isError;
				result = {
					...result,
					isError,
					content: afterResult.content ?? result.content,
					details: afterResult.details ?? result.details,
					terminate: afterResult.terminate ?? result.terminate,
				};
			}
		} catch (error) {
			result = createErrorToolResult(error instanceof Error ? error.message : String(error));
			isError = true;
		}
	}

	return {
		toolCall: prepared.toolCall,
		result,
		isError,
	};
}

function createErrorToolResult(message: string): AgentToolResult {
	return {
		isError: true,
		content: [{ type: "text", text: message }],
		details: {},
	};
}

async function emitToolExecutionEnd(finalized: FinalizedToolCallOutcome, emit: AgentEventSink): Promise<void> {
	await emit({
		type: "tool_execution_end",
		toolCallId: finalized.toolCall.id,
		toolName: finalized.toolCall.name,
		result: finalized.result,
		isError: finalized.isError,
	});
}

function createToolResultMessage(finalized: FinalizedToolCallOutcome): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: finalized.toolCall.id,
		toolName: finalized.toolCall.name,
		content: finalized.result.content ?? [],
		details: finalized.result.details,
		isError: finalized.isError,
		timestamp: Date.now(),
	};
}

async function emitToolResultMessage(toolResultMessage: ToolResultMessage, emit: AgentEventSink): Promise<void> {
	await emit({ type: "message_start", message: toolResultMessage });
	await emit({ type: "message_end", message: toolResultMessage });
}
