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
import { ToolCallScheduler, type ToolAccess } from "./tool-scheduler.ts";

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
		const { message, batch } = await runModelStep(currentContext, config, signal, emit, streamFn);
		newMessages.push(message);

		const toolResults = batch.messages;
		currentContext.messages.push(...toolResults);
		newMessages.push(...toolResults);
		if (message.stopReason === "error" || message.stopReason === "aborted" || message.partialToolExecution) {
			await emit({ type: "turn_end", message, toolResults });
			await emit({ type: "agent_end", messages: newMessages });
			return;
		}

		const hasMoreToolCalls = toolResults.length > 0 && !batch.terminate;
		// All tool results must precede injected context in Chat, Responses and Messages.
		if (!signal?.aborted) for (const injected of batch.newMessages ?? []) {
			currentContext.messages.push(injected);
			newMessages.push(injected);
			await emit({ type: "message_start", message: injected });
			await emit({ type: "message_end", message: injected });
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
		const terminated = batch.terminate;
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

/** Owns one model response and all the tool work it admits, including during cancellation. */
async function runModelStep(
	context: AgentContext, config: AgentLoopConfig, signal: AbortSignal | undefined,
	emit: AgentEventSink, streamFn: StreamFn,
): Promise<{ message: AssistantMessage; batch: ExecutedToolCallBatch }> {
	const controller = new AbortController();
	const toolSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
	const scheduler = new ToolCallScheduler<FinalizedToolCallOutcome>(toolSignal);
	const streamed = new Map<string, { call: AgentToolCall; index: number; admitted: boolean }>();
	let skipReason = "Operation aborted";
	let published = false;

	function enqueue(call: AgentToolCall, assistant: AssistantMessage, index?: number) {
		const skip = () => reportSkippedCall(call, skipReason, emit);
		if (toolSignal.aborted) {
			scheduler.add("exclusive", skip, skip);
			return;
		}
		const binding = bindToolCall(context, call, config.toolExecution);
		let access: ToolAccess | Promise<ToolAccess> = "exclusive";
		if (config.toolExecution === "parallel" && binding.kind === "prepared" && binding.tool.executionMode === "parallel") {
			const classify = binding.tool.getFileAccess;
			access = classify ? Promise.resolve().then(() => classify.call(binding.tool, binding.args as never)) : [];
		}
		scheduler.add(access,
			() => runOneToolCall(context, assistant, call, binding, config, toolSignal, emit, scheduler,
				!published && index !== undefined ? { index, model: assistant.model, timestamp: assistant.timestamp } : undefined),
			skip,
		);
	}

	try {
		const message = await streamAssistantResponse(context, config, signal, emit, streamFn, (call, index, partial, ready) => {
			if (config.toolExecution !== "parallel" || !call.id || !call.name || streamed.get(call.id)?.admitted) return;
			const snapshot = structuredClone(call);
			streamed.set(call.id, { call: snapshot, index, admitted: ready });
			if (ready) enqueue(snapshot, { ...partial, content: partial.content.slice(0, index + 1) }, index);
		});
		const incomplete = message.stopReason === "error" || message.stopReason === "aborted" || message.stopReason === "length";
		if (incomplete) {
			skipReason = message.stopReason === "length"
				? "Tool call was not executed: the response hit the output token limit, so its arguments may be truncated. Re-issue the tool call with complete arguments."
				: `Tool call was not executed: the model response ended with ${message.stopReason}.`;
			controller.abort();
			if ([...streamed.values()].some(entry => entry.admitted)) {
				// Decoders discard native calls when a response fails. Recover the admitted calls
				// and pair any subsequent announced but incomplete calls with a skipped result.
				message.partialToolExecution = true;
				for (const { call, index } of streamed.values()) {
					const old = message.content.findIndex(block => block.type === "toolCall" && block.id === call.id);
					if (old >= 0) message.content[old] = call;
					else message.content.splice(index, 0, call);
				}
			}
		}
		await emit({ type: "message_end", message });
		published = true;

		const calls = message.content.filter(block => block.type === "toolCall");
		const messages: ToolResultMessage[] = [];
		const publishResult = async (outcome: FinalizedToolCallOutcome) => {
			const result = createToolResultMessage(outcome);
			await emitToolResultMessage(result, emit);
			messages.push(result);
		};

		let ordered: FinalizedToolCallOutcome[];
		if (config.toolExecution === "parallel") {
			for (const call of calls) {
				if (!streamed.get(call.id)?.admitted) enqueue(call, message);
			}
			// Native adapters admit an ordered prefix early; terminal-only calls follow in source order.
			ordered = await scheduler.finish();
			for (const outcome of ordered) await publishResult(outcome);
		} else {
			// Existing sequential callers can steer or abort from a result event before the next call.
			ordered = [];
			for (const call of calls) {
				const outcome = toolSignal.aborted ? await reportSkippedCall(call, skipReason, emit) :
					await runOneToolCall(context, message, call, bindToolCall(context, call), config, toolSignal, emit, scheduler);
				ordered.push(outcome);
				await publishResult(outcome);
			}
			await scheduler.finish();
		}
		return { message, batch: {
			messages,
			newMessages: ordered.flatMap(call => call.isError ? [] : call.result.newMessages ?? []),
			terminate: shouldTerminateToolBatch(ordered),
		} };
	} catch (error) {
		controller.abort();
		await scheduler.finish();
		throw error;
	}
}

async function streamAssistantResponse(
	context: AgentContext,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
	streamFn: StreamFn,
	onToolBlock: (call: AgentToolCall, index: number, message: AssistantMessage, ready: boolean) => void,
): Promise<AssistantMessage> {
	const messages = config.transformContext ? await config.transformContext(context.messages, signal) : context.messages;
	const llmContext: Context = {
		systemPrompt: context.systemPrompt,
		messages: await config.convertToLlm(messages),
		tools: context.tools,
	};
	const resolvedApiKey =
		config.getApiKey ? await config.getApiKey(config.model.provider, config.model) : config.apiKey;
	signal?.throwIfAborted();
	const response = await streamFn(config.model, llmContext, {
		apiKey: resolvedApiKey, signal,
		maxTokens: config.maxTokens ?? config.model.maxOutputTokens,
		thinking: config.thinking ? { ...config.thinking } : undefined,
	});

	const position = context.messages.length;
	let finalMessage: AssistantMessage;
	try {
		for await (const event of response) {
			if (event.type === "done" || event.type === "error") break;
			context.messages[position] = event.partial;
			if (event.type === "start") {
				await emit({ type: "message_start", message: { ...event.partial } });
			} else {
				await emit({ type: "message_update", assistantMessageEvent: event, message: { ...event.partial } });
				if (event.type === "toolcall_start") {
					const block = event.partial.content[event.contentIndex];
					if (block?.type === "toolCall") onToolBlock(block, event.contentIndex, event.partial, false);
				} else if (event.type === "toolcall_end" && event.earlyExecution &&
					(event.partial.stopReason === "stop" || event.partial.stopReason === "toolUse")) {
					onToolBlock(event.toolCall, event.contentIndex, event.partial, true);
				}
			}
		}
		finalMessage = await response.result();
	} catch (error) {
		const partial = context.messages[position];
		if (partial?.role !== "assistant") throw error;
		finalMessage = { ...partial, stopReason: signal?.aborted ? "aborted" : "error",
			errorMessage: error instanceof Error ? error.message : String(error) };
	}
	const started = context.messages.length > position;
	context.messages[position] = finalMessage;
	if (!started) await emit({ type: "message_start", message: { ...finalMessage } });
	return finalMessage;
}

async function reportSkippedCall(call: AgentToolCall, reason: string, emit: AgentEventSink): Promise<FinalizedToolCallOutcome> {
	await emit({ type: "tool_execution_start", toolCallId: call.id, toolName: call.name, args: call.arguments });
	const outcome = { toolCall: call, result: createErrorToolResult(reason), isError: true };
	await emitToolExecutionEnd(outcome, emit);
	return outcome;
}

async function runOneToolCall(
	context: AgentContext, assistant: AssistantMessage, call: AgentToolCall,
	binding: PreparedToolCall | ImmediateToolCallOutcome, config: AgentLoopConfig,
	signal: AbortSignal, emit: AgentEventSink, scheduler: ToolCallScheduler<FinalizedToolCallOutcome>,
	streaming?: { index: number; model: string; timestamp: number },
): Promise<FinalizedToolCallOutcome> {
	const displayArgs = binding.kind === "prepared" && binding.scheduledByFile ? structuredClone(binding.toolCall.arguments) : call.arguments;
	await emit({ type: "tool_execution_start", toolCallId: call.id, toolName: call.name, args: displayArgs, ...(streaming && { streaming }) });
	const prepared = binding.kind === "prepared" ? await prepareToolCall(context, assistant, binding, config, signal) : binding;
	let outcome: FinalizedToolCallOutcome;
	if (prepared.kind === "immediate") {
		outcome = { toolCall: call, result: prepared.result, isError: prepared.isError };
	} else {
		let executed: ExecutedToolCallOutcome | undefined;
		try {
			executed = await scheduler.withExecutionSlot(() => executePreparedToolCall(prepared, signal, emit));
		} catch (error) {
			if (!signal.aborted) throw error;
		} finally {
			prepared.reservation?.release();
		}
		// A call cancelled while waiting for capacity never reached the tool or its completion hook.
		outcome = executed
			? await finalizeExecutedToolCall(context, assistant, prepared, executed, config, signal)
			: { toolCall: call, result: createErrorToolResult("Operation aborted"), isError: true };
	}
	await emitToolExecutionEnd(outcome, emit);
	return outcome;
}

type PreparedToolCall = {
	kind: "prepared";
	toolCall: AgentToolCall;
	tool: AgentTool;
	scheduledByFile?: true;
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

/** Tool inputs are JSON. Freeze the private snapshot after normalization and before classifying it. */
function freezeToolInput<T>(value: T): T {
	if (value && typeof value === "object" && !Object.isFrozen(value)) {
		Object.freeze(value);
		for (const nested of Object.values(value)) freezeToolInput(nested);
	}
	return value;
}

function bindToolCall(context: AgentContext, toolCall: AgentToolCall, mode?: AgentLoopConfig["toolExecution"]): PreparedToolCall | ImmediateToolCallOutcome {
	const tool = context.tools?.find(candidate => candidate.name === toolCall.name);
	if (!tool) return { kind: "immediate", result: createErrorToolResult(`Tool ${toolCall.name} not found`), isError: true };
	try {
		const args = validateToolArguments(tool, prepareToolCallArguments(tool, toolCall));
		if (mode === "parallel" && tool.executionMode === "parallel" && tool.getFileAccess) {
			const snapshot = freezeToolInput(structuredClone(toolCall));
			const scheduledArgs = args === toolCall.arguments ? snapshot.arguments : freezeToolInput(structuredClone(args));
			return { kind: "prepared", toolCall: snapshot, tool, args: scheduledArgs, scheduledByFile: true };
		}
		return { kind: "prepared", toolCall, tool, args };
	} catch (error) {
		return { kind: "immediate", result: createErrorToolResult(error instanceof Error ? error.message : String(error)), isError: true };
	}
}

async function prepareToolCall(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	binding: PreparedToolCall,
	config: AgentLoopConfig,
	signal: AbortSignal,
): Promise<PreparedToolCall | ImmediateToolCallOutcome> {
	if (signal.aborted) return { kind: "immediate", result: createErrorToolResult("Operation aborted"), isError: true };
	const { tool, toolCall, args: validatedArgs } = binding;
	let reservation: PreparedToolCall["reservation"];
	try {
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
			const approval = { reserveForApproval, assistantMessage, toolCall, args: validatedArgs, permission, context: currentContext };
			// Composed approval hooks must all see the same classified target and arguments.
			const beforeResult = await config.beforeToolCall(binding.scheduledByFile ? Object.freeze(approval) : approval, signal);
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
		await Promise.allSettled(updateEvents);
		const reason = error instanceof Error ? error.message : String(error);
		return {
			result: createErrorToolResult(signal?.aborted ? `${reason}（执行结果未知，继续前请核对。）` : reason),
			isError: true,
		};
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
