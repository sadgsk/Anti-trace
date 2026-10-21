import { Agent } from "../agent/agent.ts";
import { ByokConfigError } from "../config/errors.ts";
import type { AgentEvent, ImageContent, Model, ModelReference, ModelRequestSettings, SessionSettings, StreamFn, ThinkingLevel, ThinkingPreferences } from "../types.ts";
import { THINKING_LEVELS } from "../llm/rules.ts";
import { validateModelThinking } from "../llm/adapter.ts";
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
	modelRef?: ModelReference;
	thinking?: ThinkingPreferences;
	apiKey?: string;
	/** Resolve the configured model's key when a model operation actually needs it. */
	getApiKey?: (model: Model) => string | undefined | Promise<string | undefined>;
}

export interface HarnessOptions extends Partial<HarnessModelSettings> {
	cwd: string;
	streamFn: StreamFn;
	sessionsRoot?: string;
	resolveModel?: (reference: ModelReference) => HarnessModelSettings;
}

export class Harness {
	readonly agent: Agent;
	private readonly cwd: string;
	private readonly sessionsRoot: string;
	private session!: SessionFile;
	private usedTokens = 0;
	private promptController: AbortController | undefined;
	private compactionController: AbortController | undefined;
	private getApiKey?: HarnessModelSettings["getApiKey"];
	private modelRef?: ModelReference;
	private readonly resolveModel?: HarnessOptions["resolveModel"];
	private restoreWarning?: string;

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
		this.modelRef = options.modelRef ? { ...options.modelRef } : undefined;
		this.resolveModel = options.resolveModel;
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
		if (options.model) this.agent.getApiKey = this.createRequestSettings(false).getApiKey;
		this.newSession();
		this.agent.subscribe((event) => {
			if (event.type !== "message_end") {
				return;
			}
			appendEntry(this.session, { type: "message", message: event.message });
		});
	}

	async prompt(text: string, images?: ImageContent[]): Promise<void> {
		this.assertIdle();
		const settings = this.createRequestSettings();
		// Own the entire prompt, including the gap between an agent turn and its summary/retry.
		const controller = new AbortController();
		this.promptController = controller;
		try {
			// Resolve before transcript/image side effects, then consume this key on the first
			// request. Tool continuations and summary retries resolve again.
			const resolver = settings.getApiKey!;
			let firstKey = await resolver(settings.model.provider, settings.model);
			controller.signal.throwIfAborted();
			settings.getApiKey = (provider, model) => {
				if (firstKey !== undefined && model.id === settings.model.id && this.sameConnection(model, settings.model)) {
					const key = firstKey;
					firstKey = undefined;
					return key;
				}
				firstKey = undefined;
				return resolver(provider, model);
			};
			// A restored session may have fallen back to the active catalog. Persist the
			// effective settings before new messages, without rewriting its earlier history.
			this.recordSettings(this.settings);
			await this.runPrompt(text, images, controller.signal, settings);
		} finally {
			this.promptController = undefined;
		}
	}

	private async runPrompt(text: string, images: ImageContent[] | undefined, signal: AbortSignal, settings: ModelRequestSettings): Promise<void> {
		// Images stay in context as real blocks (so the model sees them right away) and are also
		// written next to the session jsonl, so the model can `read` one back after compaction
		// replaces that part of the history with a summary.
		let promptText = text;
		if (images && images.length > 0) {
			const paths = images.map((image) => saveSessionImage(this.session.path, image));
			const note = `[Attached image(s) saved at: ${paths.join(", ")}]`;
			promptText = promptText.length > 0 ? `${promptText}\n\n${note}` : note;
		}
		await this.agent.prompt(promptText, images, settings);
		// Provider-reported usage is authoritative; fall back to the character estimate when the
		// gateway does not send it (or when the stream was aborted before the usage chunk).
		this.usedTokens = this.usageFromLastAssistant() ?? estimateMessagesTokens(this.agent.state.messages);
		if (signal.aborted) return;
		const lastMessage = this.agent.state.messages.at(-1);
		if (lastMessage?.role !== "assistant") {
			return;
		}
		const window = settings.model.contextWindow;
		const overflow = isContextOverflow(lastMessage, window);
		if (overflow && (lastMessage.stopReason === "error" || lastMessage.stopReason === "length")) {
			const originalMessages = this.agent.state.messages;
			this.agent.state.messages = originalMessages.slice(0, -1);
			let compacted: boolean;
			try {
				compacted = await this.compactWithSignal(undefined, signal, settings);
			} catch (error) {
				this.agent.state.messages = originalMessages;
				throw error;
			}
			if (!compacted) {
				this.agent.state.messages = originalMessages;
				return;
			}
			if (signal.aborted) return;
			await this.agent.continueFromContext(settings);
			this.usedTokens = this.usageFromLastAssistant() ?? estimateMessagesTokens(this.agent.state.messages);
			return;
		}
		if (
			lastMessage.stopReason === "stop" &&
			(overflow || shouldCompact(this.usedTokens, window, DEFAULT_COMPACTION_SETTINGS))
		) {
			await this.compactWithSignal(undefined, signal, settings);
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
		this.assertIdle();
		this.agent.reset();
		this.usedTokens = 0;
		this.session = createSessionFile(this.cwd, this.sessionsRoot);
		this.restoreWarning = undefined;
		this.recordSettings(this.settings);
	}

	listSessions(): SessionListItem[] {
		return listSessionFiles(this.cwd, this.sessionsRoot);
	}

	resumeAt(index: number): boolean {
		this.assertIdle();
		if (!Number.isInteger(index) || index < 1) {
			return false;
		}
		const item = this.listSessions()[index - 1];
		if (!item) {
			return false;
		}
		const loaded = loadSession(item.filePath);
		let restored: HarnessModelSettings | undefined;
		let warning: string | undefined;
		if (loaded.settings?.modelRef) {
			try {
				if (!this.resolveModel) throw new ByokConfigError("当前入口没有可用的模型目录。");
				restored = this.resolveModel(loaded.settings.modelRef);
			} catch (error) {
				if (!(error instanceof ByokConfigError)) throw error;
				warning = `未恢复模型 ${loaded.settings.modelRef.modelKey}：${error.message} 当前模型：${this.agent.state.model?.name ?? "未配置"}；会话历史已保留。`;
			}
		}
		touchSession(item.filePath);
		this.agent.reset();
		this.agent.state.messages = loaded.messages;
		this.session = {
			path: item.filePath,
			header: loaded.header,
			entries: loaded.entries,
			flushed: true,
		};
		this.usedTokens = estimateMessagesTokens(loaded.messages);
		if (restored) this.applyModel(restored);
		if (loaded.settings) this.agent.state.thinking = { ...loaded.settings.thinking };
		this.restoreWarning = warning;
		return true;
	}

	get settings(): SessionSettings {
		return { ...(this.modelRef ? { modelRef: { ...this.modelRef } } : {}), thinking: { ...this.agent.state.thinking } };
	}

	get settingsWarning(): string | undefined { return this.restoreWarning; }

	describeSettings(): string {
		const thinking = this.agent.state.thinking;
		return `模型：${this.modelRef?.modelKey ?? this.agent.state.model?.name ?? "未配置"} · 思考：${thinking.enabled === undefined ? "服务端默认" : thinking.enabled ? "开启" : "关闭"} · 档位：${thinking.effort}`;
	}

	setThinkingLevel(level: ThinkingLevel): void {
		this.setThinking({ ...this.agent.state.thinking, effort: level });
	}

	setThinkingEnabled(enabled: boolean | undefined): void {
		this.setThinking({ effort: this.agent.state.thinking.effort, ...(enabled === undefined ? {} : { enabled }) });
	}

	private setThinking(thinking: ThinkingPreferences): void {
		this.assertIdle();
		this.validatePreferences(thinking);
		if (this.agent.state.model) validateModelThinking(this.agent.state.model, thinking);
		this.recordSettings({ ...this.settings, thinking });
		this.agent.state.thinking = { ...thinking };
	}

	/** Apply a fully validated configuration without replacing messages, session or subscribers. */
	configureModel(settings: HarnessModelSettings): void {
		const thinking: ThinkingPreferences = { ...settings.thinking, effort: settings.thinking?.effort ?? "medium" };
		this.assertIdle();
		this.validatePreferences(thinking);
		const candidate = { ...settings, model: structuredClone(settings.model), thinking };
		this.recordSettings({ modelRef: settings.modelRef, thinking });
		this.applyModel(candidate);
		this.restoreWarning = undefined;
	}

	private applyModel(settings: HarnessModelSettings): void {
		this.agent.state.model = structuredClone(settings.model);
		this.modelRef = settings.modelRef ? { ...settings.modelRef } : undefined;
		if (settings.thinking) this.agent.state.thinking = { ...settings.thinking };
		this.getApiKey = settings.getApiKey;
		this.agent.apiKey = settings.apiKey;
		// Direct Agent users retain the same credential boundary as Harness users.
		this.agent.getApiKey = this.createRequestSettings(false).getApiKey;
	}

	private validatePreferences(thinking: ThinkingPreferences): void {
		if (!THINKING_LEVELS.includes(thinking.effort) || (thinking.enabled !== undefined && typeof thinking.enabled !== "boolean")) {
			throw new ByokConfigError("思考档位必须是 low / medium / high / xhigh / max，开关必须是布尔值或默认。");
		}
	}

	private recordSettings(settings: SessionSettings): void {
		const previous = [...this.session.entries].reverse().find(entry => entry.type === "settings");
		if (previous && JSON.stringify({ modelRef: previous.modelRef, thinking: previous.thinking }) === JSON.stringify(settings)) return;
		appendEntry(this.session, { type: "settings", ...structuredClone(settings) });
	}

	private assertIdle(): void {
		if (this.agent.state.isStreaming || this.promptController || this.compactionController) {
			throw new Error("Cannot change settings or sessions while the agent is processing.");
		}
	}

	private requireModel(): Model {
		const model = this.agent.state.model;
		if (!model) throw new ByokConfigError("尚无可用模型配置，请先加载有效的模型配置后重试；会话管理仍可使用。");
		return model;
	}

	private sameConnection(left: Model, right: Model): boolean {
		return left.provider === right.provider && left.api === right.api &&
			left.baseUrl.replace(/\/+$/, "") === right.baseUrl.replace(/\/+$/, "") && left.endpoint === right.endpoint;
	}

	private createRequestSettings(validate = true): ModelRequestSettings {
		const model = structuredClone(this.requireModel());
		const thinking = { ...this.agent.state.thinking };
		if (validate) validateModelThinking(model, thinking);
		const getter = this.getApiKey;
		const staticKey = this.agent.apiKey;
		return { model, thinking, getApiKey: async (_provider, requestedModel) => {
			if (!getter && !this.sameConnection(model, requestedModel)) throw new ByokConfigError("切换接口后不能继续使用原连接的静态凭据。");
			const key = (getter ? await getter(requestedModel) : staticKey)?.trim();
			if (!key) throw new ByokConfigError("当前模型缺少凭据，请配置 apiKey 或 apiKeyEnv 后重试。");
			return key;
		} };
	}

	setContextWindow(tokens: number): void {
		this.assertIdle();
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
		if ([...this.session.entries].reverse().find(entry => entry.type !== "settings")?.type === "compaction") {
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

	private async compactWithSignal(customInstructions?: string, parentSignal?: AbortSignal, settings?: ModelRequestSettings): Promise<boolean> {
		if (this.agent.state.isStreaming || this.compactionController) {
			throw new Error("Cannot compact while the agent is processing");
		}
		this.requireModel();
		const messages = this.agent.state.messages;
		const cutIndex = findCutIndex(messages, DEFAULT_COMPACTION_SETTINGS.keepRecentTokens);
		if (cutIndex === 0) {
			return false;
		}
		const request = settings ?? this.createRequestSettings(false);
		const controller = new AbortController();
		const signal = parentSignal ? AbortSignal.any([parentSignal, controller.signal]) : controller.signal;
		this.compactionController = controller;
		try {
			signal.throwIfAborted();
			const converted = await this.agent.convertToLlm(messages);
			signal.throwIfAborted();
			const summary = await summarizeConversation({
				streamFn: this.agent.streamFunction,
				model: request.model,
				context: {
					systemPrompt: this.agent.state.systemPrompt,
					messages: converted,
					tools: this.agent.state.tools,
				},
				getApiKey: request.getApiKey,
				thinking: request.thinking,
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
