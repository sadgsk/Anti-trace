/**
 * 探针：用假 StreamFn 跑 Agent.prompt，验 state.messages。不打真实 LLM。
 *
 * 在 cli-agent 根目录：npx tsx test/probe-agent.ts
 */
import { Type } from "typebox";
import { Agent } from "../src/agent/agent.ts";
import { buildSystemPrompt } from "../src/prompt.ts";
import type { AgentEvent, AgentTool, Model } from "../src/types.ts";
import { createFakeStreamFn, type FakeStreamTurn } from "./fake-stream.ts";

const fakeModel: Model = {
	id: "fake",
	name: "fake",
	provider: "fake",
	baseUrl: "http://fake.local",
	api: "openai-completions",
};

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

function createAgent(turns: readonly FakeStreamTurn[], tools: AgentTool[] = []): Agent {
	return new Agent({
		streamFn: createFakeStreamFn(turns),
		initialState: {
			systemPrompt: buildSystemPrompt({
				cwd: process.cwd(),
				toolNames: tools.map((tool) => tool.name),
			}),
			model: fakeModel,
			tools,
		},
	});
}

function rolesOf(agent: Agent): string {
	return agent.state.messages.map((message) => message.role).join(",");
}

function textOf(agent: Agent, index: number): string {
	const message = agent.state.messages[index];
	if (!message || (message.role !== "user" && message.role !== "assistant" && message.role !== "toolResult")) {
		return "";
	}
	return message.content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map((block) => block.text)
		.join("");
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

await runCase("1. prompt(hi) 后 messages 是 user+assistant", async () => {
	const events: AgentEvent[] = [];
	const agent = createAgent([{ text: "hello" }]);
	agent.subscribe((event) => {
		events.push(event);
	});

	await agent.prompt("hi");

	console.log("roles =", rolesOf(agent));
	console.log("assistant =", JSON.stringify(textOf(agent, 1)));
	if (rolesOf(agent) !== "user,assistant") {
		throw new Error(`unexpected roles: ${rolesOf(agent)}`);
	}
	if (textOf(agent, 0) !== "hi") {
		throw new Error(`expected user hi, got ${JSON.stringify(textOf(agent, 0))}`);
	}
	if (textOf(agent, 1) !== "hello") {
		throw new Error(`expected assistant hello, got ${JSON.stringify(textOf(agent, 1))}`);
	}
	if (events[0]?.type !== "agent_start" || events[events.length - 1]?.type !== "agent_end") {
		throw new Error("expected subscribe to see agent_start ... agent_end");
	}
});

await runCase("2. prompt 先 toolCall 再文本", async () => {
	const executed: string[] = [];
	const agent = createAgent(
		[
			{ toolCalls: [{ id: "call-1", name: "echo", arguments: { text: "hello" } }] },
			{ text: "echoed hello" },
		],
		[createEchoTool((text) => executed.push(text))],
	);

	await agent.prompt("use echo");

	console.log("roles =", rolesOf(agent));
	if (rolesOf(agent) !== "user,assistant,toolResult,assistant") {
		throw new Error(`unexpected roles: ${rolesOf(agent)}`);
	}
	if (executed.join(",") !== "hello") {
		throw new Error(`expected echo hello, got ${JSON.stringify(executed)}`);
	}
	if (textOf(agent, 3) !== "echoed hello") {
		throw new Error(`expected final text, got ${JSON.stringify(textOf(agent, 3))}`);
	}
});

await runCase("3. reset 清空 messages", async () => {
	const agent = createAgent([{ text: "hello" }]);
	await agent.prompt("hi");
	agent.reset();
	if (agent.state.messages.length !== 0) {
		throw new Error(`expected empty messages, got ${rolesOf(agent)}`);
	}
});

if (failed > 0) {
	console.error(`\n${failed} case(s) failed`);
	process.exit(1);
}
console.log("\nall cases passed");
