/**
 * Stateful wrapper around the low-level agent loop.
 *
 * Agent owns the transcript and forwards loop events to subscribers.
 * It does not know about readline, bash, or env.
 */

import type {
	AfterToolCallContext,
	AfterToolCallResult,
	AgentContext,
	AgentEvent,
	AgentLoopConfig,
	AgentLoopTurnUpdate,
	AgentMessage,
	AgentState,
	AgentTool,
	BeforeModelRequestContext,
	BeforeToolCallContext,
	BeforeToolCallResult,
	ImageContent,
	Message,
	Model,
	ModelRequestSettings,
	ApiKeyResolver,
	PrepareNextTurnContext,
	ShouldStopAfterTurnContext,
	StreamFn,
	ToolExecutionMode,
	UserMessage,
} from "../types.ts";
import { runAgentLoop } from "./loop.ts";

function defaultConvertToLlm(messages: AgentMessage[]): Message[] {
	const result: Message[] = [];
	for (let i = 0; i < messages.length; i++) {
		const message = messages[i];
		if (message.role === "assistant" && message.partialToolExecution) {
			// An interrupted stream has no replayable native reasoning/signature. Preserve the actual
			// tool effects as context on the next prompt, including when the session is reopened.
			const content: UserMessage["content"] = [{ type: "text", text:
				`Tool execution record from an interrupted model response (${message.stopReason}). Check these outcomes before repeating an operation.` }];
			for (const block of message.content) {
				if (block.type === "toolCall") content.push({ type: "text", text: `${block.id}: ${block.name}(${JSON.stringify(block.arguments)})` });
				else if (block.type === "text") content.push(block);
			}
			while (messages[i + 1]?.role === "toolResult") {
				const next = messages[++i];
				if (next.role === "toolResult") content.push(
					{ type: "text", text: `Result for ${next.toolCallId} (${next.isError ? "error" : "success"}):` }, ...next.content);
			}
			result.push({ role: "user", isMeta: true, content, timestamp: message.timestamp });
		} else if (message.role === "user" || message.role === "assistant" || message.role === "toolResult") {
			result.push(message);
		}
	}
	return result;
}

type AgentStateInit = Partial<
	Omit<AgentState, "pendingToolCalls" | "isStreaming" | "streamingMessage" | "errorMessage">
>;

type MutableAgentState = Omit<AgentState, "isStreaming" | "streamingMessage" | "pendingToolCalls" | "errorMessage"> & {
	isStreaming: boolean;
	streamingMessage?: AgentMessage;
	pendingToolCalls: Set<string>;
	errorMessage?: string;
};

function createMutableAgentState(initialState?: AgentStateInit): MutableAgentState {
	let tools = initialState?.tools?.slice() ?? [];
	let messages = initialState?.messages?.slice() ?? [];

	return {
		systemPrompt: initialState?.systemPrompt ?? "",
		model: initialState?.model,
		thinking: initialState?.thinking ? { ...initialState.thinking } : { effort: "medium" },
		get tools() {
			return tools;
		},
		set tools(nextTools: AgentTool[]) {
			tools = nextTools.slice();
		},
		get messages() {
			return messages;
		},
		set messages(nextMessages: AgentMessage[]) {
			messages = nextMessages.slice();
		},
		isStreaming: false,
		streamingMessage: undefined,
		pendingToolCalls: new Set<string>(),
		errorMessage: undefined,
	};
}

export interface AgentOptions {
	initialState?: AgentStateInit;
	streamFn: StreamFn;
	convertToLlm?: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
	transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;
	beforeModelRequest?: (request: BeforeModelRequestContext, signal?: AbortSignal) => Promise<AgentContext | undefined>;
	apiKey?: string;
	getApiKey?: ApiKeyResolver;
	beforeToolCall?: (context: BeforeToolCallContext, signal?: AbortSignal) => Promise<BeforeToolCallResult | undefined>;
	afterToolCall?: (context: AfterToolCallContext, signal?: AbortSignal) => Promise<AfterToolCallResult | undefined>;
	shouldStopAfterTurn?: (context: ShouldStopAfterTurnContext) => boolean | Promise<boolean>;
	prepareNextTurn?: (
		context: PrepareNextTurnContext,
	) => AgentLoopTurnUpdate | undefined | Promise<AgentLoopTurnUpdate | undefined>;
	toolExecution?: ToolExecutionMode;
}

type ActiveRun = {
	promise: Promise<void>;
	resolve: () => void;
	abortController: AbortController;
};

export class Agent {
	private _state: MutableAgentState;
	private readonly listeners = new Set<(event: AgentEvent, signal: AbortSignal) => Promise<void> | void>();
	private activeRun?: ActiveRun;
	private pendingSteering: AgentMessage[] = [];
	private readonly steeringListeners = new Set<() => void>();

	public convertToLlm: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
	public transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;
	public beforeModelRequest?: AgentOptions["beforeModelRequest"];
	public streamFunction: StreamFn;
	public apiKey?: string;
	public getApiKey?: ApiKeyResolver;
	public beforeToolCall?: (
		context: BeforeToolCallContext,
		signal?: AbortSignal,
	) => Promise<BeforeToolCallResult | undefined>;
	public afterToolCall?: (
		context: AfterToolCallContext,
		signal?: AbortSignal,
	) => Promise<AfterToolCallResult | undefined>;
	public shouldStopAfterTurn?: (context: ShouldStopAfterTurnContext) => boolean | Promise<boolean>;
	public prepareNextTurn?: (
		context: PrepareNextTurnContext,
	) => AgentLoopTurnUpdate | undefined | Promise<AgentLoopTurnUpdate | undefined>;
	public toolExecution?: ToolExecutionMode;

	constructor(options: AgentOptions) {
		this._state = createMutableAgentState(options.initialState);
		this.convertToLlm = options.convertToLlm ?? defaultConvertToLlm;
		this.transformContext = options.transformContext;
		this.beforeModelRequest = options.beforeModelRequest;
		this.streamFunction = options.streamFn;
		this.apiKey = options.apiKey;
		this.getApiKey = options.getApiKey;
		this.beforeToolCall = options.beforeToolCall;
		this.afterToolCall = options.afterToolCall;
		this.shouldStopAfterTurn = options.shouldStopAfterTurn;
		this.prepareNextTurn = options.prepareNextTurn;
		this.toolExecution = options.toolExecution;
	}

	get state(): AgentState {
		return this._state;
	}

	subscribe(listener: (event: AgentEvent, signal: AbortSignal) => Promise<void> | void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	get signal(): AbortSignal | undefined {
		return this.activeRun?.abortController.signal;
	}

	queueSteering(text: string, images?: ImageContent[]): void {
		this.pendingSteering.push({ ...this.createUserMessage(text, images), metadata: { kind: "steering" } });
		for (const listener of this.steeringListeners) listener();
	}

	hasPendingSteering(): boolean {
		return this.pendingSteering.length > 0;
	}

	onSteering(listener: () => void): () => void {
		this.steeringListeners.add(listener);
		return () => { this.steeringListeners.delete(listener); };
	}

	/** Persist accepted input that arrived after the final loop boundary. */
	async flushSteering(signal: AbortSignal): Promise<void> {
		while (this.pendingSteering.length) {
			const user = this.pendingSteering.shift()!;
			await this.processEvents({ type: "message_start", message: user }, signal);
			await this.processEvents({ type: "message_end", message: user }, signal);
		}
	}

	abort(): void {
		this.activeRun?.abortController.abort();
	}

	waitForIdle(): Promise<void> {
		return this.activeRun?.promise ?? Promise.resolve();
	}

	reset(): void {
		if (this.activeRun) {
			throw new Error("Agent is already processing. Wait for completion before resetting.");
		}

		this._state.messages = [];
		this.pendingSteering = [];
		this._state.isStreaming = false;
		this._state.streamingMessage = undefined;
		this._state.pendingToolCalls = new Set<string>();
		this._state.errorMessage = undefined;
	}

	async prompt(text: string, images?: ImageContent[], settings?: ModelRequestSettings, additionalMessages: readonly AgentMessage[] = []): Promise<void> {
		const config = this.createLoopConfig(settings);
		const messages = [this.createUserMessage(text, images), ...additionalMessages];
		await this.runWithLifecycle(config.model, async (signal) => {
			await runAgentLoop(
				[...this.pendingSteering.splice(0), ...messages],
				this.createContextSnapshot(),
				config,
				(event) => this.processEvents(event),
				signal,
				this.streamFunction,
			);
		});
	}

	/** Run another model turn using the messages already in state, without adding a user message. */
	async continueFromContext(settings?: ModelRequestSettings): Promise<void> {
		const config = this.createLoopConfig(settings);
		await this.runWithLifecycle(config.model, async (signal) => {
			await runAgentLoop(
				this.pendingSteering.splice(0),
				this.createContextSnapshot(),
				config,
				(event) => this.processEvents(event),
				signal,
				this.streamFunction,
			);
		});
	}

	private createUserMessage(text: string, images?: ImageContent[]): UserMessage {
		const content: Array<{ type: "text"; text: string } | ImageContent> = [];
		if (text.length > 0) {
			content.push({ type: "text", text });
		}
		if (images && images.length > 0) {
			content.push(...images);
		}
		if (content.length === 0) {
			content.push({ type: "text", text: "" });
		}
		return { role: "user", content, timestamp: Date.now() };
	}

	private createContextSnapshot(): AgentContext {
		return {
			systemPrompt: this._state.systemPrompt,
			messages: this._state.messages.slice(),
			tools: this._state.tools.slice(),
		};
	}

	private createLoopConfig(settings?: ModelRequestSettings): AgentLoopConfig {
		const model = settings?.model ?? this._state.model;
		if (!model) throw new Error("尚未配置模型，无法发起模型请求。");
		const beforeModelRequest = this.beforeModelRequest;
		return {
			// Detach request settings from state so tools and subscribers cannot change this run.
			model: structuredClone(model),
			thinking: { ...(settings?.thinking ?? this._state.thinking) },
			convertToLlm: this.convertToLlm,
			transformContext: this.transformContext,
			beforeModelRequest: beforeModelRequest ? async (request, signal) => {
				const next = await beforeModelRequest(request, signal);
				signal?.throwIfAborted();
				if (next) this._state.messages = next.messages;
				return next;
			} : undefined,
			apiKey: settings ? settings.apiKey : this.apiKey,
			getApiKey: settings ? settings.getApiKey : this.getApiKey,
			beforeToolCall: this.beforeToolCall,
			afterToolCall: this.afterToolCall,
			shouldStopAfterTurn: this.shouldStopAfterTurn,
			prepareNextTurn: this.prepareNextTurn,
			toolExecution: this.toolExecution,
			getSteeringMessages: async () => this.pendingSteering.splice(0),
		};
	}
//	emit function
	private async processEvents(event: AgentEvent, signal = this.signal): Promise<void> {
		switch (event.type) {
			case "message_start":
				this._state.streamingMessage = event.message;
				break;

			case "message_update":
				this._state.streamingMessage = event.message;
				break;

			case "message_end":
				this._state.streamingMessage = undefined;
				this._state.messages.push(event.message);
				break;

			case "tool_execution_start": {
				const pendingToolCalls = new Set(this._state.pendingToolCalls);
				pendingToolCalls.add(event.toolCallId);
				this._state.pendingToolCalls = pendingToolCalls;
				break;
			}

			case "tool_execution_end": {
				const pendingToolCalls = new Set(this._state.pendingToolCalls);
				pendingToolCalls.delete(event.toolCallId);
				this._state.pendingToolCalls = pendingToolCalls;
				break;
			}

			case "turn_end":
				if (event.message.role === "assistant" && event.message.errorMessage) {
					this._state.errorMessage = event.message.errorMessage;
				}
				break;

			case "agent_end":
				this._state.streamingMessage = undefined;
				break;
		}

		if (!signal) {
			throw new Error("Agent listener invoked outside active run");
		}
		for (const listener of this.listeners) {
			await listener(event, signal);
		}
	}

	private async handleRunFailure(error: unknown, aborted: boolean, model: Model): Promise<void> {
		const failureMessage: AgentMessage = {
			role: "assistant",
			content: [{ type: "text", text: "" }],
			model: model.id,
			stopReason: aborted ? "aborted" : "error",
			errorMessage: error instanceof Error ? error.message : String(error),
			timestamp: Date.now(),
		};
		await this.processEvents({ type: "message_start", message: failureMessage });
		await this.processEvents({ type: "message_end", message: failureMessage });
		await this.processEvents({ type: "turn_end", message: failureMessage, toolResults: [] });
		await this.processEvents({ type: "agent_end", messages: [failureMessage] });
	}

	private finishRun(): void {
		this._state.isStreaming = false;
		this._state.streamingMessage = undefined;
		this._state.pendingToolCalls = new Set<string>();
		this.activeRun?.resolve();
		this.activeRun = undefined;
	}

	private async runWithLifecycle(model: Model, executor: (signal: AbortSignal) => Promise<void>): Promise<void> {
		if (this.activeRun) {
			throw new Error("Agent is already processing.");
		}

		const abortController = new AbortController();
		let resolvePromise = () => {};
		const promise = new Promise<void>((resolve) => {
			resolvePromise = resolve;
		});
		this.activeRun = { promise, resolve: resolvePromise, abortController };

		this._state.isStreaming = true;
		this._state.streamingMessage = undefined;
		this._state.errorMessage = undefined;

		try {
			await executor(abortController.signal);
		} catch (error) {
			await this.handleRunFailure(error, abortController.signal.aborted, model);
		} finally {
			this.finishRun();
		}
	}
}
