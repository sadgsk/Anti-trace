import { Agent } from "../agent/agent.ts";
import type { AgentEvent, ImageContent, Model, StreamFn, ThinkingLevel } from "../types.ts";
import {
	buildCompactSummaryMessage,
	DEFAULT_COMPACTION_SETTINGS,
	findCutIndex,
	isContextOverflow,
	shouldCompact,
	summarizeConversation,
} from "./compaction.ts";
import { estimateMessagesTokens } from "./context.ts";
import { buildSystemPrompt } from "./prompt.ts";
import {
	appendEntry,
	createSessionFile,
	DEFAULT_SESSIONS_ROOT,
	listSessions as listSessionFiles,
	loadSession,
	saveSessionImage,
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
	private usedTokens = 0;

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

	async prompt(text: string, images?: ImageContent[]): Promise<void> {
		// Images stay in context as real blocks (so the model sees them right away) and are also
		// written next to the session jsonl, so the model can `read` one back after compaction
		// replaces that part of the history with a summary.
		let promptText = text;
		if (images && images.length > 0) {
			const paths = images.map((image) => saveSessionImage(this.session.path, image));
			const note = `[Attached image(s) saved at: ${paths.join(", ")}]`;
			promptText = promptText.length > 0 ? `${promptText}\n\n${note}` : note;
		}
		await this.agent.prompt(promptText, images);
		// Provider-reported usage is authoritative; fall back to the character estimate when the
		// gateway does not send it (or when the stream was aborted before the usage chunk).
		this.usedTokens = this.usageFromLastAssistant() ?? estimateMessagesTokens(this.agent.state.messages);
		const lastMessage = this.agent.state.messages.at(-1);
		if (lastMessage?.role !== "assistant") {
			return;
		}
		const window = this.agent.state.model.contextWindow;
		const overflow = isContextOverflow(lastMessage, window);
		if (overflow && (lastMessage.stopReason === "error" || lastMessage.stopReason === "length")) {
			const originalMessages = this.agent.state.messages;
			this.agent.state.messages = originalMessages.slice(0, -1);
			let compacted: boolean;
			try {
				compacted = await this.compact();
			} catch (error) {
				this.agent.state.messages = originalMessages;
				throw error;
			}
			if (!compacted) {
				this.agent.state.messages = originalMessages;
				return;
			}
			await this.agent.continueFromContext();
			this.usedTokens = this.usageFromLastAssistant() ?? estimateMessagesTokens(this.agent.state.messages);
			return;
		}
		if (
			lastMessage.stopReason === "stop" &&
			(overflow || shouldCompact(this.usedTokens, window, DEFAULT_COMPACTION_SETTINGS))
		) {
			await this.compact();
		}
	}

	/** input + output of the final assistant turn: what the next request would resend. */
	private usageFromLastAssistant(): number | undefined {
		const messages = this.agent.state.messages;
		for (let index = messages.length - 1; index >= 0; index -= 1) {
			const message = messages[index];
			if (message?.role !== "assistant") {
				continue;
			}
			if (!message.usage) {
				return undefined;
			}
			return message.usage.input + message.usage.output;
		}
		return undefined;
	}

	abort(): void {
		this.agent.abort();
	}

	subscribe(listener: (event: AgentEvent, signal: AbortSignal) => Promise<void> | void): () => void {
		return this.agent.subscribe(listener);
	}

	newSession(): void {
		this.agent.reset();
		this.usedTokens = 0;
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
		this.usedTokens = estimateMessagesTokens(loaded.messages);
		return true;
	}

	setThinkingLevel(_level: ThinkingLevel): void {
		throw new Error("未接上");
	}

	setContextWindow(tokens: number): void {
		if (!Number.isInteger(tokens) || tokens <= 0) {
			throw new Error("context window 需要正整数");
		}
		this.agent.state.model = { ...this.agent.state.model, contextWindow: tokens };
	}

	contextUsage(): { used: number; window: number } {
		return { used: this.usedTokens, window: this.agent.state.model.contextWindow };
	}

	async manualCompact(): Promise<"compacted" | "below-threshold" | "nothing-to-compact"> {
		if (this.agent.state.isStreaming) {
			throw new Error("Cannot compact while the agent is processing");
		}
		const { used, window } = this.contextUsage();
		if (used <= window / 4) {
			return "below-threshold";
		}
		if (this.session.entries.at(-1)?.type === "compaction") {
			return "nothing-to-compact";
		}
		return (await this.compact()) ? "compacted" : "nothing-to-compact";
	}

	async compact(customInstructions?: string): Promise<boolean> {
		if (this.agent.state.isStreaming) {
			throw new Error("Cannot compact while the agent is processing");
		}
		const messages = this.agent.state.messages;
		const cutIndex = findCutIndex(messages, DEFAULT_COMPACTION_SETTINGS.keepRecentTokens);
		if (cutIndex === 0) {
			return false;
		}
		const apiKey = this.agent.apiKey;
		if (!apiKey) {
			throw new Error("Compaction requires an API key");
		}

		const summary = await summarizeConversation({
			streamFn: this.agent.streamFunction,
			model: this.agent.state.model,
			context: {
				systemPrompt: this.agent.state.systemPrompt,
				messages: await this.agent.convertToLlm(messages),
				tools: this.agent.state.tools,
			},
			apiKey,
			reserveTokens: DEFAULT_COMPACTION_SETTINGS.reserveTokens,
			customInstructions,
		});
		const keptMessages = messages.slice(cutIndex);
		const wrappedSummary = buildCompactSummaryMessage(summary, {
			transcriptPath: this.session.path,
			recentMessagesPreserved: keptMessages.length > 0,
		});
		const headerTime = Date.parse(this.session.header.timestamp);
		const compactedMessages = [
			{
				role: "user" as const,
				content: [{ type: "text" as const, text: wrappedSummary }],
				timestamp: Number.isNaN(headerTime) ? 0 : headerTime,
			},
			...keptMessages,
		];
		appendEntry(this.session, {
			type: "compaction",
			summary: wrappedSummary,
			keptMessages,
			tokensBefore: this.usedTokens,
		});
		this.agent.state.messages = compactedMessages;
		this.usedTokens = estimateMessagesTokens(compactedMessages);
		return true;
	}
}
