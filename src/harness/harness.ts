import { Agent } from "../agent/agent.ts";
import { ByokConfigError } from "../config/errors.ts";
import type { AgentEvent, ImageContent, Model, StreamFn, ThinkingLevel, ThinkingPreferences } from "../types.ts";
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

export interface HarnessModelSettings {
	model: Model;
	thinking?: ThinkingPreferences;
	apiKey?: string;
	/** Resolve the configured model's key when a model operation actually needs it. */
	getApiKey?: () => string;
}

export interface HarnessOptions extends Partial<HarnessModelSettings> {
	cwd: string;
	streamFn: StreamFn;
	sessionsRoot?: string;
}

export class Harness {
	readonly agent: Agent;
	private readonly cwd: string;
	private readonly sessionsRoot: string;
	private session!: SessionFile;
	private usedTokens = 0;
	private promptController: AbortController | undefined;
	private compactionController: AbortController | undefined;
	private getApiKey?: () => string;

	constructor(options: HarnessOptions) {
		const tools = [
			createReadTool(options.cwd),
			createBashTool(options.cwd),
			createEditTool(options.cwd),
			createWriteTool(options.cwd),
		];
		this.cwd = options.cwd;
		this.sessionsRoot = options.sessionsRoot ?? DEFAULT_SESSIONS_ROOT;
		this.getApiKey = options.getApiKey;
		this.agent = new Agent({
			streamFn: options.streamFn,
			apiKey: options.apiKey,
			initialState: {
				systemPrompt: buildSystemPrompt({
					cwd: options.cwd,
					toolNames: tools.map((tool) => tool.name),
				}),
				model: options.model,
				thinking: options.thinking,
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
		if (this.promptController || this.compactionController) {
			throw new Error("Harness is already processing.");
		}
		const model = this.requireModel();
		// Fail before persisting images or adding a user message when no model/key is available.
		this.agent.apiKey = this.resolveApiKey();
		// Own the entire prompt, including the gap between an agent turn and its summary/retry.
		const controller = new AbortController();
		this.promptController = controller;
		try {
			await this.runPrompt(text, images, controller.signal, model);
		} finally {
			this.promptController = undefined;
		}
	}

	private async runPrompt(text: string, images: ImageContent[] | undefined, signal: AbortSignal, model: Model): Promise<void> {
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
		if (signal.aborted) return;
		const lastMessage = this.agent.state.messages.at(-1);
		if (lastMessage?.role !== "assistant") {
			return;
		}
		const window = model.contextWindow;
		const overflow = isContextOverflow(lastMessage, window);
		if (overflow && (lastMessage.stopReason === "error" || lastMessage.stopReason === "length")) {
			const originalMessages = this.agent.state.messages;
			this.agent.state.messages = originalMessages.slice(0, -1);
			let compacted: boolean;
			try {
				compacted = await this.compactWithSignal(undefined, signal);
			} catch (error) {
				this.agent.state.messages = originalMessages;
				throw error;
			}
			if (!compacted) {
				this.agent.state.messages = originalMessages;
				return;
			}
			if (signal.aborted) return;
			await this.agent.continueFromContext();
			this.usedTokens = this.usageFromLastAssistant() ?? estimateMessagesTokens(this.agent.state.messages);
			return;
		}
		if (
			lastMessage.stopReason === "stop" &&
			(overflow || shouldCompact(this.usedTokens, window, DEFAULT_COMPACTION_SETTINGS))
		) {
			await this.compactWithSignal(undefined, signal);
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
		this.promptController?.abort();
		this.compactionController?.abort();
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

	/** Apply a fully validated configuration without replacing messages, session or subscribers. */
	configureModel(settings: HarnessModelSettings): void {
		if (this.agent.state.isStreaming || this.promptController || this.compactionController) {
			throw new Error("Cannot configure a model while the agent is processing");
		}
		const model = structuredClone(settings.model);
		const thinking: ThinkingPreferences = { ...settings.thinking, effort: settings.thinking?.effort ?? "medium" };
		this.agent.state.model = model;
		this.agent.state.thinking = thinking;
		this.getApiKey = settings.getApiKey;
		this.agent.apiKey = settings.apiKey;
	}

	private requireModel(): Model {
		const model = this.agent.state.model;
		if (!model) throw new ByokConfigError("尚无可用模型配置，请先加载有效的模型配置后重试；会话管理仍可使用。");
		return model;
	}

	private resolveApiKey(): string {
		// 当前凭据按 prompt／摘要操作解析，工具续接沿用本轮快照。
		// 10／11 批扩展逐请求动态凭据时，普通请求与压缩仍须共用解析入口和错误边界。
		const apiKey = (this.getApiKey ? this.getApiKey() : this.agent.apiKey)?.trim();
		if (!apiKey) throw new ByokConfigError("当前模型缺少凭据，请配置 apiKey 或 apiKeyEnv 后重试。");
		return apiKey;
	}

	setContextWindow(tokens: number): void {
		if (!Number.isInteger(tokens) || tokens <= 0) {
			throw new Error("context window 需要正整数");
		}
		this.agent.state.model = { ...this.requireModel(), contextWindow: tokens };
	}

	contextUsage(): { used: number; window: number | undefined } {
		return { used: this.usedTokens, window: this.agent.state.model?.contextWindow };
	}

	async manualCompact(): Promise<"compacted" | "below-threshold" | "nothing-to-compact"> {
		if (this.agent.state.isStreaming || this.promptController || this.compactionController) {
			throw new Error("Cannot compact while the agent is processing");
		}
		const model = this.requireModel();
		if (this.usedTokens <= model.contextWindow / 4) {
			return "below-threshold";
		}
		if (this.session.entries.at(-1)?.type === "compaction") {
			return "nothing-to-compact";
		}
		return (await this.compact()) ? "compacted" : "nothing-to-compact";
	}

	async compact(customInstructions?: string): Promise<boolean> {
		if (this.promptController) {
			throw new Error("Cannot compact while the agent is processing");
		}
		return this.compactWithSignal(customInstructions);
	}

	private async compactWithSignal(customInstructions?: string, parentSignal?: AbortSignal): Promise<boolean> {
		if (this.agent.state.isStreaming || this.compactionController) {
			throw new Error("Cannot compact while the agent is processing");
		}
		const model = this.requireModel();
		const messages = this.agent.state.messages;
		const cutIndex = findCutIndex(messages, DEFAULT_COMPACTION_SETTINGS.keepRecentTokens);
		if (cutIndex === 0) {
			return false;
		}
		const apiKey = this.resolveApiKey();
		const controller = new AbortController();
		const signal = parentSignal ? AbortSignal.any([parentSignal, controller.signal]) : controller.signal;
		this.compactionController = controller;
		try {
			signal.throwIfAborted();
			const converted = await this.agent.convertToLlm(messages);
			signal.throwIfAborted();
			const summary = await summarizeConversation({
				streamFn: this.agent.streamFunction,
				model,
				context: {
					systemPrompt: this.agent.state.systemPrompt,
					messages: converted,
					tools: this.agent.state.tools,
				},
				apiKey,
				reserveTokens: DEFAULT_COMPACTION_SETTINGS.reserveTokens,
				customInstructions,
				signal,
			});
			// Even an injected provider that ignores cancellation must not commit an aborted summary.
			signal.throwIfAborted();
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
		} finally {
			this.compactionController = undefined;
		}
	}
}
