import type { Static,TSchema } from "typebox";

// Content blocks：一条消息 content 数组里的单项
export interface TextContent{
     type: "text";
     text: string;
}

export interface ThinkingContent{
     type: "thinking";
     thinking: string;
}

export interface ImageContent{
     type: "image";
     data: string;
     mimeType: string;
}

export interface ToolCall {
	type: "toolCall";
	id: string;
	name: string;
	arguments: Record<string, any>;
}

// Messages：对话记录里的一条；transcript 就是 Message[]
export type StopReason = "stop" | "length" | "toolUse" | "error" | "aborted" ;

export interface UserMessage {
	role: "user";
	content:(TextContent | ImageContent)[];
	timestamp: number; // Unix timestamp in milliseconds
}

export interface AssistantMessage {
	role: "assistant";
	content: (TextContent | ThinkingContent | ToolCall)[];
	model: string;
	stopReason: StopReason;
	errorMessage?: string;
	timestamp: number; // Unix timestamp in milliseconds
}

export interface ToolResultMessage<TDetails = any>{
     role: "toolResult";
	toolCallId: string;
	toolName: string;
	content: (TextContent | ImageContent)[]; // Supports text and images
     isError: boolean;
	timestamp: number; // Unix timestamp in milliseconds
     details?: TDetails;
}

export type Message = UserMessage | AssistantMessage | ToolResultMessage;

export interface CustomAgentMessages {}
export type AgentMessage = Message | CustomAgentMessages[keyof CustomAgentMessages];

// LLM request：一次模型调用用的模型、工具说明书、上下文
export interface Model {
	id: string;
	name: string;
	provider: string;
	baseUrl: string;
	api: "openai-completions";
}

export interface Tool<TParameters extends TSchema = TSchema> {
	name: string;
	description: string;
	parameters: TParameters;
}

export interface Context {
	systemPrompt?: string;
	messages: Message[];
	tools?: Tool[];
}

// Stream：模型流式输出的事件，以及调用模型的函数类型
export interface StreamOptions{
     apiKey?: string;
     signal?: AbortSignal;
}

export type AssistantMessageEvent =
	| { type: "start"; partial: AssistantMessage }
	| { type: "text_start"; contentIndex: number; partial: AssistantMessage }
	| { type: "text_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
	| { type: "text_end"; contentIndex: number; content: string; partial: AssistantMessage }
	| { type: "thinking_start"; contentIndex: number; partial: AssistantMessage }
	| { type: "thinking_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
	| { type: "thinking_end"; contentIndex: number; content: string; partial: AssistantMessage }
	| { type: "toolcall_start"; contentIndex: number; partial: AssistantMessage }
	| { type: "toolcall_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
	| { type: "toolcall_end"; contentIndex: number; toolCall: ToolCall; partial: AssistantMessage }
	| {
			type: "done";
			reason: Extract<StopReason, "stop" | "length" | "toolUse">;
			message: AssistantMessage;
	  }
	| { type: "error"; reason: Extract<StopReason, "aborted" | "error">; error: AssistantMessage };

export interface AssistantMessageEventStream extends AsyncIterable<AssistantMessageEvent> {
     result(): Promise<AssistantMessage>;
}

export type StreamFn = (
	model: Model,
	context: Context,
	options?: StreamOptions,
) => AssistantMessageEventStream | Promise<AssistantMessageEventStream>;

// Tools：模型看到的是 Tool；loop 真正调用的是 AgentTool.execute
export type ToolExecutionMode = "sequential" | "parallel";

export interface AgentToolResult<T = unknown> {
	/** Text or image content returned to the model. */
	content: (TextContent | ImageContent)[];
	/** Arbitrary structured details for logs or UI rendering. */
	details: T;
	/**
	 * Hint that the agent should stop after the current tool batch.
	 * Early termination only happens when every finalized tool result in the batch sets this to true.
	 */
	terminate?: boolean;
}

export interface AgentTool<TParameters extends TSchema = TSchema, TDetails = unknown> extends Tool<TParameters> {
	label: string;
	prepareArguments?: (args: unknown) => Static<TParameters>;
	execute: (
		toolCallId: string,
		params: Static<TParameters>,
		signal?: AbortSignal,
		onUpdate?: (partial: AgentToolResult<TDetails>) => void,
	) => Promise<AgentToolResult<TDetails>>;
	executionMode?: ToolExecutionMode;
}

export type AgentToolCall = Extract<AssistantMessage["content"][number], { type: "toolCall" }>;

export interface AgentContext {
	systemPrompt: string;
	messages: AgentMessage[];
	tools?: AgentTool[];
}

// Loop config：v1 会用 model / convertToLlm / apiKey；其余 hook 先留口子
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high";

export interface BeforeToolCallResult {
	block?: boolean;
	reason?: string;
	terminate?: boolean;
}

export interface AfterToolCallResult {
	content?: Array<TextContent | ImageContent>;
	details?: unknown;
	isError?: boolean;
	terminate?: boolean;
}

export interface BeforeToolCallContext {
	assistantMessage: AssistantMessage;
	toolCall: AgentToolCall;
	args: unknown;
	context: AgentContext;
}

export interface AfterToolCallContext {
	assistantMessage: AssistantMessage;
	toolCall: AgentToolCall;
	args: unknown;
	result: AgentToolResult;
	isError: boolean;
	context: AgentContext;
}

export interface ShouldStopAfterTurnContext {
	message: AssistantMessage;
	toolResults: ToolResultMessage[];
	context: AgentContext;
	newMessages: AgentMessage[];
}

export interface AgentLoopTurnUpdate {
	context?: AgentContext;
	model?: Model;
	thinkingLevel?: ThinkingLevel;
}

export type PrepareNextTurnContext = ShouldStopAfterTurnContext;

export interface AgentLoopConfig extends StreamOptions {
	model: Model;
	convertToLlm: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
	transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;
	getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
	shouldStopAfterTurn?: (context: ShouldStopAfterTurnContext) => boolean | Promise<boolean>;
	prepareNextTurn?: (
		context: PrepareNextTurnContext,
	) => AgentLoopTurnUpdate | undefined | Promise<AgentLoopTurnUpdate | undefined>;
	getSteeringMessages?: () => Promise<AgentMessage[]>;
	getFollowUpMessages?: () => Promise<AgentMessage[]>;
	toolExecution?: ToolExecutionMode;
	beforeToolCall?: (context: BeforeToolCallContext, signal?: AbortSignal) => Promise<BeforeToolCallResult | undefined>;
	afterToolCall?: (context: AfterToolCallContext, signal?: AbortSignal) => Promise<AfterToolCallResult | undefined>;
}

export type AgentEventSink = (event: AgentEvent) => Promise<void> | void;

// Agent：对外状态，以及 loop 打给 CLI 的事件
export interface AgentState {
	systemPrompt: string;
	model: Model;
	thinkingLevel: ThinkingLevel;
	set tools(tools: AgentTool[]);
	get tools(): AgentTool[];
	set messages(messages: AgentMessage[]);
	get messages(): AgentMessage[];
	readonly isStreaming: boolean;
	readonly streamingMessage?: AgentMessage;
	readonly pendingToolCalls: ReadonlySet<string>;
	readonly errorMessage?: string;
}

export type AgentEvent =
	| { type: "agent_start" }
	| { type: "agent_end"; messages: AgentMessage[] }
	| { type: "turn_start" }
	| { type: "turn_end"; message: AgentMessage; toolResults: ToolResultMessage[] }
	| { type: "message_start"; message: AgentMessage }
	| { type: "message_update"; message: AgentMessage; assistantMessageEvent: AssistantMessageEvent }
	| { type: "message_end"; message: AgentMessage }
	| { type: "tool_execution_start"; toolCallId: string; toolName: string; args: unknown }
	| { type: "tool_execution_update"; toolCallId: string; toolName: string; args: unknown; partialResult: unknown }
	| { type: "tool_execution_end"; toolCallId: string; toolName: string; result: unknown; isError: boolean };

