/**
 * 探针：用假 StreamFn 跑 runAgentLoop，验 event 顺序。不打真实 LLM。
 *
 * 在 cli-agent 根目录：npx tsx test/probe-loop.ts
 */
import { Type } from "typebox";
import { runAgentLoop } from "../src/agent/loop.ts";
import type {
	AgentContext,
	AgentEvent,
	AgentLoopConfig,
	AgentMessage,
	AgentTool,
	Message,
	Model,
	UserMessage,
} from "../src/types.ts";
import { createFakeStreamFn, type FakeStreamTurn } from "./fake-stream.ts";

function summarizeEvent(event: AgentEvent): string {
	switch (event.type) {
		case "agent_start":
		case "turn_start":
			return event.type;
		case "agent_end":
			return "agent_end";
		case "turn_end":
			return `turn_end toolResults=${event.toolResults.length}`;
		case "message_start":
			return `message_start ${event.message.role}`;
		case "message_end":
			return `message_end ${event.message.role}`;
		case "message_update":
			return `message_update ${event.assistantMessageEvent.type}`;
		case "tool_execution_start":
			return `tool_execution_start ${event.toolName}`;
		case "tool_execution_update":
			return `tool_execution_update ${event.toolName}`;
		case "tool_execution_end":
			return `tool_execution_end ${event.toolName} error=${event.isError}`;
	}
}

function convertToLlm(messages: AgentMessage[]): Message[] {
	return messages.filter(
		(message): message is Message =>
			message.role === "user" || message.role === "assistant" || message.role === "toolResult",
	);
}

const echoSchema = Type.Object({
	text: Type.String({ description: "Text to echo" }),
});

function createEchoTool(onExecute?: (text: string) => void): AgentTool<typeof echoSchema, { text: string }> {
	return {
		name: "echo",
		label: "echo",
		description: "Echo a short text back.",
		parameters: echoSchema,
		async execute(_toolCallId, { text }) {
			onExecute?.(text);
			return {
				content: [{ type: "text", text }],
				details: { text },
			};
		},
	};
}

const fakeModel: Model = {
	id: "fake",
	name: "fake",
	provider: "fake",
	baseUrl: "http://fake.local",
	api: "openai-completions",
};

function createUserMessage(text: string): UserMessage {
	return {
		role: "user",
		content: [{ type: "text", text }],
		timestamp: Date.now(),
	};
}

function assertSequence(actual: string[], expected: string[]): void {
	const actualText = actual.join("\n");
	const expectedText = expected.join("\n");
	if (actualText !== expectedText) {
		throw new Error(`event sequence mismatch\n--- expected ---\n${expectedText}\n--- actual ---\n${actualText}`);
	}
}

function textOf(message: AgentMessage): string {
	if (message.role !== "assistant" && message.role !== "toolResult" && message.role !== "user") {
		return "";
	}
	return message.content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map((block) => block.text)
		.join("");
}

async function collectLoop(
	tools: AgentTool[],
	turns: readonly FakeStreamTurn[],
	prompt = "probe",
): Promise<{ events: AgentEvent[]; messages: AgentMessage[]; summaries: string[] }> {
	const events: AgentEvent[] = [];
	const context: AgentContext = {
		systemPrompt: "You are a test probe.",
		messages: [],
		tools,
	};
	const config: AgentLoopConfig = {
		model: fakeModel,
		convertToLlm,
	};
	const messages = await runAgentLoop(
		[createUserMessage(prompt)],
		context,
		config,
		(event) => {
			events.push(event);
		},
		undefined,
		createFakeStreamFn(turns),
	);
	return { events, messages, summaries: events.map(summarizeEvent) };
}

let failed = 0;

async function runCase(title: string, fn: () => Promise<void>): Promise<void> {
	console.log(`\n======== ${title} ========`);
	try {
		await fn();
		console.log("PASS");
	} catch (error) {
		failed += 1;
		console.error("FAIL", error instanceof Error ? error.message : error);
	}
}

await runCase("1. 纯文本，不调工具", async () => {
	const executed: string[] = [];
	const { messages, summaries } = await collectLoop([createEchoTool((text) => executed.push(text))], [
		{ text: "好" },
	]);

	console.log(summaries.join("\n"));
	assertSequence(summaries, [
		"agent_start",
		"turn_start",
		"message_start user",
		"message_end user",
		"message_start assistant",
		"message_update text_start",
		"message_update text_delta",
		"message_update text_end",
		"message_end assistant",
		"turn_end toolResults=0",
		"agent_end",
	]);
	if (executed.length !== 0) {
		throw new Error(`expected no tool execute, got ${JSON.stringify(executed)}`);
	}
	if (messages.map((message) => message.role).join(",") !== "user,assistant") {
		throw new Error(`unexpected roles: ${messages.map((message) => message.role).join(",")}`);
	}
	if (textOf(messages[1]!) !== "好") {
		throw new Error(`expected assistant text 好, got ${JSON.stringify(textOf(messages[1]!))}`);
	}
});

await runCase("2. 先 toolCall 再文本", async () => {
	const executed: string[] = [];
	const { messages, summaries } = await collectLoop([createEchoTool((text) => executed.push(text))], [
		{
			toolCalls: [{ id: "call-1", name: "echo", arguments: { text: "hello" } }],
		},
		{ text: "echoed hello" },
	]);

	console.log(summaries.join("\n"));
	assertSequence(summaries, [
		"agent_start",
		"turn_start",
		"message_start user",
		"message_end user",
		"message_start assistant",
		"message_update toolcall_start",
		"message_update toolcall_delta",
		"message_update toolcall_end",
		"message_end assistant",
		"tool_execution_start echo",
		"tool_execution_end echo error=false",
		"message_start toolResult",
		"message_end toolResult",
		"turn_end toolResults=1",
		"turn_start",
		"message_start assistant",
		"message_update text_start",
		"message_update text_delta",
		"message_update text_end",
		"message_end assistant",
		"turn_end toolResults=0",
		"agent_end",
	]);
	if (executed.join(",") !== "hello") {
		throw new Error(`expected echo hello, got ${JSON.stringify(executed)}`);
	}
	if (messages.map((message) => message.role).join(",") !== "user,assistant,toolResult,assistant") {
		throw new Error(`unexpected roles: ${messages.map((message) => message.role).join(",")}`);
	}
	if (textOf(messages[2]!) !== "hello") {
		throw new Error(`expected toolResult hello, got ${JSON.stringify(textOf(messages[2]!))}`);
	}
	if (textOf(messages[3]!) !== "echoed hello") {
		throw new Error(`expected final text echoed hello, got ${JSON.stringify(textOf(messages[3]!))}`);
	}
});

await runCase("3. 模型 error，不执行工具", async () => {
	const executed: string[] = [];
	const { messages, summaries } = await collectLoop([createEchoTool((text) => executed.push(text))], [
		{ error: "boom" },
	]);

	console.log(summaries.join("\n"));
	assertSequence(summaries, [
		"agent_start",
		"turn_start",
		"message_start user",
		"message_end user",
		"message_start assistant",
		"message_end assistant",
		"turn_end toolResults=0",
		"agent_end",
	]);
	if (executed.length !== 0) {
		throw new Error(`expected no tool execute, got ${JSON.stringify(executed)}`);
	}
	const assistant = messages[1];
	if (!assistant || assistant.role !== "assistant" || assistant.stopReason !== "error") {
		throw new Error(`expected assistant stopReason error, got ${JSON.stringify(assistant)}`);
	}
});

await runCase("4. length + toolCall 不真正 execute，再继续一轮", async () => {
	const executed: string[] = [];
	const { messages, summaries } = await collectLoop([createEchoTool((text) => executed.push(text))], [
		{
			toolCalls: [{ id: "call-1", name: "echo", arguments: { text: "hello" } }],
			stopReason: "length",
		},
		{ text: "retried after truncate" },
	]);

	console.log(summaries.join("\n"));
	assertSequence(summaries, [
		"agent_start",
		"turn_start",
		"message_start user",
		"message_end user",
		"message_start assistant",
		"message_update toolcall_start",
		"message_update toolcall_delta",
		"message_update toolcall_end",
		"message_end assistant",
		"tool_execution_start echo",
		"tool_execution_end echo error=true",
		"message_start toolResult",
		"message_end toolResult",
		"turn_end toolResults=1",
		"turn_start",
		"message_start assistant",
		"message_update text_start",
		"message_update text_delta",
		"message_update text_end",
		"message_end assistant",
		"turn_end toolResults=0",
		"agent_end",
	]);
	if (executed.length !== 0) {
		throw new Error(`expected truncated toolCall not to execute, got ${JSON.stringify(executed)}`);
	}
	const toolResult = messages[2];
	if (!toolResult || toolResult.role !== "toolResult" || toolResult.isError !== true) {
		throw new Error(`expected error toolResult, got ${JSON.stringify(toolResult)}`);
	}
	if (textOf(messages[3]!) !== "retried after truncate") {
		throw new Error(`expected retry text, got ${JSON.stringify(textOf(messages[3]!))}`);
	}
});

if (failed > 0) {
	console.error(`\n${failed} case(s) failed`);
	process.exit(1);
}
console.log("\nall cases passed");
