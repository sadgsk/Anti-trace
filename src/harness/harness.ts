import { Agent } from "../agent/agent.ts";
import type { AgentEvent, Model, StreamFn, ThinkingLevel } from "../types.ts";
import { buildSystemPrompt } from "./prompt.ts";
import {
	appendEntry,
	createSessionFile,
	DEFAULT_SESSIONS_ROOT,
	listSessions as listSessionFiles,
	loadSession,
	touchSession,
	type SessionFile,
	type SessionListItem,
} from "./session.ts";
import { createBashTool } from "./tools/bash.ts";
import { createEditTool } from "./tools/edit.ts";
import { createReadTool } from "./tools/read.ts";
import { createWriteTool } from "./tools/write.ts";

export interface HarnessOptions {
	cwd: string;
	apiKey: string;
	model: Model;
	streamFn: StreamFn;
	sessionsRoot?: string;
}

export class Harness {
	readonly agent: Agent;
	private readonly cwd: string;
	private readonly sessionsRoot: string;
	private session!: SessionFile;

	constructor(options: HarnessOptions) {
		const tools = [
			createReadTool(options.cwd),
			createBashTool(options.cwd),
			createEditTool(options.cwd),
			createWriteTool(options.cwd),
		];
		this.cwd = options.cwd;
		this.sessionsRoot = options.sessionsRoot ?? DEFAULT_SESSIONS_ROOT;
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
		this.newSession();
		this.agent.subscribe((event) => {
			if (event.type !== "message_end") {
				return;
			}
			appendEntry(this.session, { type: "message", message: event.message });
		});
	}

	prompt(text: string): Promise<void> {
		return this.agent.prompt(text);
	}

	abort(): void {
		this.agent.abort();
	}

	subscribe(listener: (event: AgentEvent, signal: AbortSignal) => Promise<void> | void): () => void {
		return this.agent.subscribe(listener);
	}

	newSession(): void {
		this.agent.reset();
		this.session = createSessionFile(this.cwd, this.sessionsRoot);
	}

	listSessions(): SessionListItem[] {
		return listSessionFiles(this.cwd, this.sessionsRoot);
	}

	resumeAt(index: number): boolean {
		if (!Number.isInteger(index) || index < 1) {
			return false;
		}
		const item = this.listSessions()[index - 1];
		if (!item) {
			return false;
		}
		touchSession(item.filePath);
		const loaded = loadSession(item.filePath);
		this.agent.reset();
		this.agent.state.messages = loaded.messages;
		this.session = {
			path: item.filePath,
			header: loaded.header,
			entries: loaded.entries,
			flushed: true,
		};
		return true;
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
