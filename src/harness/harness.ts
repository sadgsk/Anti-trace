import { Agent } from "../agent/agent.ts";
import type { AgentEvent, Model, StreamFn, ThinkingLevel } from "../types.ts";
import { buildSystemPrompt } from "./prompt.ts";
import { createBashTool } from "./tools/bash.ts";
import { createEditTool } from "./tools/edit.ts";
import { createReadTool } from "./tools/read.ts";
import { createWriteTool } from "./tools/write.ts";

export interface HarnessOptions {
	cwd: string;
	apiKey: string;
	model: Model;
	streamFn: StreamFn;
}

export class Harness {
	readonly agent: Agent;
	private readonly cwd: string;

	constructor(options: HarnessOptions) {
		const tools = [
			createReadTool(options.cwd),
			createBashTool(options.cwd),
			createEditTool(options.cwd),
			createWriteTool(options.cwd),
		];
		this.cwd = options.cwd;
		this.agent = new Agent({
			streamFn: options.streamFn,
			apiKey: options.apiKey,
			initialState: {
				systemPrompt: buildSystemPrompt({
					cwd: options.cwd,
					toolNames: tools.map((tool) => tool.name),
				}),
				model: options.model,
				tools,
			},
		});
	}

	prompt(text: string): Promise<void> {
		return this.agent.prompt(text);
	}

	reset(): void {
		this.agent.reset();
	}

	abort(): void {
		this.agent.abort();
	}

	subscribe(listener: (event: AgentEvent, signal: AbortSignal) => Promise<void> | void): () => void {
		return this.agent.subscribe(listener);
	}

	newSession(): void {
		throw new Error("未接上");
	}

	resumeRecent(): boolean {
		throw new Error("未接上");
	}

	setThinkingLevel(_level: ThinkingLevel): void {
		throw new Error("未接上");
	}

	setContextWindow(_tokens: number): void {
		throw new Error("未接上");
	}

	contextUsage(): { used: number; window: number } {
		throw new Error("未接上");
	}

	async compact(_customInstructions?: string): Promise<void> {
		throw new Error("未接上");
	}
}
