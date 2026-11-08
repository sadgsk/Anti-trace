import { Agent } from "../agent/agent.ts";
import { ByokConfigError } from "../config/errors.ts";
import type { AgentContext, AgentEvent, AgentMessage, AssistantMessage, BeforeModelRequestContext, BeforeToolCallContext, BeforeToolCallResult, ImageContent, Model, ModelReference, ModelRequestSettings, SessionSettings, StreamFn, ThinkingLevel, ThinkingPreferences } from "../types.ts";
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
import { estimateContextTokens, estimateMessagesTokens } from "./context.ts";
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
	type SessionEntry,
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

export type PromptResult = { status: "success" } | { status: "error"; message: string } | { status: "aborted"; message: string };

export type HarnessEvent = AgentEvent
	| { type: "prompt_end"; result: PromptResult }
	| { type: "compaction_start"; tokensBefore: number }
	| { type: "compaction_end"; tokensBefore: number; tokensAfter: number; summary: string }
	| { type: "compaction_error"; message: string };
export interface HarnessDisplayState {
	modelName: string; thinking: ThinkingPreferences; contextUsed: number; contextWindow?: number; sessionTitle: string;
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
	private activeUserMessage?: AgentMessage;
	private preparationFailed = false;
	private requestKey?: string;
	private requestSettings?: ModelRequestSettings;
	private usageBaseline?: { message: AssistantMessage; key: string };
	private justCompacted?: AgentMessage[];
	private readonly displayListeners = new Set<(event: HarnessEvent, signal: AbortSignal) => Promise<void> | void>();

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
			beforeModelRequest: (request, signal) => this.prepareModelRequest(request, signal),
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
			if (event.message.role === "assistant") {
				this.usageBaseline = event.message.usage && this.requestKey ? { message: event.message, key: this.requestKey } : undefined;
				this.usedTokens = event.message.usage ? event.message.usage.input + event.message.usage.output : estimateContextTokens(this.liveContext());
			}
		});
	}

	async prompt(text: string, images?: ImageContent[]): Promise<void> {
		this.assertIdle();
		// Own the entire prompt, including the gap between an agent turn and its summary/retry.
		const controller = new AbortController();
		this.promptController = controller;
		this.activeUserMessage = undefined;
		this.preparationFailed = false;
		this.requestSettings = undefined;
		let result: PromptResult = { status: "error", message: "请求失败。" };
		try {
			const settings = this.createRequestSettings();
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
			result = await this.runPrompt(text, images, controller.signal, settings);
		} catch (error) {
			result = { status: controller.signal.aborted ? "aborted" : "error", message: error instanceof Error ? error.message : String(error) };
			throw error;
		} finally {
			try {
				await this.emitDisplay({ type: "prompt_end", result }, controller.signal);
			} finally {
				this.promptController = undefined;
				this.activeUserMessage = undefined;
			}
		}
	}

	private async runPrompt(text: string, images: ImageContent[] | undefined, signal: AbortSignal, settings: ModelRequestSettings): Promise<PromptResult> {
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
		const effectiveSettings = this.requestSettings ?? settings;
		if (signal.aborted) return { status: "aborted", message: "已中断。" };
		const lastMessage = this.agent.state.messages.at(-1);
		if (lastMessage?.role !== "assistant" || this.preparationFailed) return this.promptResult(signal, effectiveSettings.model.contextWindow);
		const window = effectiveSettings.model.contextWindow;
		const overflow = isContextOverflow(lastMessage, window);
		if (overflow && (lastMessage.stopReason === "error" || lastMessage.stopReason === "length")) {
			const originalMessages = this.agent.state.messages;
			this.agent.state.messages = originalMessages.slice(0, -1);
			let compacted: boolean;
			try {
				compacted = Boolean(await this.compactContext(this.liveContext(), signal, effectiveSettings, { replacesError: true }));
			} catch (error) {
				this.agent.state.messages = originalMessages;
				throw error;
			}
			if (!compacted) {
				this.agent.state.messages = originalMessages;
				return this.promptResult(signal, window);
			}
			if (signal.aborted) return { status: "aborted", message: "已中断。" };
			await this.agent.continueFromContext(effectiveSettings);
		}
		return this.promptResult(signal, this.requestSettings?.model.contextWindow ?? window);
	}

	private promptResult(signal: AbortSignal, window: number): PromptResult {
		if (signal.aborted) return { status: "aborted", message: "已中断。" };
		const message = [...this.agent.state.messages].reverse().find(message => message.role === "assistant");
		if (!message) return { status: "error", message: "未获得模型执行结果。" };
		if (message.stopReason === "aborted") return { status: "aborted", message: message.errorMessage ?? "已中断。" };
		if (message.errorMessage || message.stopReason === "error") return { status: "error", message: message.errorMessage || "请求失败。" };
		if (message.stopReason === "length" && isContextOverflow(message, window)) return { status: "error", message: "上下文超限，请求未恢复。" };
		return { status: "success" };
	}

	private liveContext(): AgentContext {
		return { systemPrompt: this.agent.state.systemPrompt, messages: this.agent.state.messages, tools: this.agent.state.tools };
	}

	private estimateRequestUsage(context: AgentContext, key: string): number {
		const baseline = this.usageBaseline;
		const index = baseline?.key === key ? context.messages.indexOf(baseline.message) : -1;
		if (baseline && index >= 0 && baseline.message.usage) {
			return baseline.message.usage.input + baseline.message.usage.output + estimateMessagesTokens(context.messages.slice(index + 1));
		}
		return estimateContextTokens(context);
	}

	private async prepareModelRequest(request: BeforeModelRequestContext, agentSignal?: AbortSignal): Promise<AgentContext | undefined> {
		if (!this.promptController) return undefined;
		const signal = agentSignal ? AbortSignal.any([this.promptController.signal, agentSignal]) : this.promptController.signal;
		signal.throwIfAborted();
		this.activeUserMessage ??= [...request.context.messages].reverse().find(message => message.role === "user");
		const key = JSON.stringify([request.model, request.context.systemPrompt,
			request.context.tools?.map(({ name, description, parameters }) => ({ name, description, parameters }))]);
		this.requestKey = key;
		this.requestSettings = { model: request.model, thinking: request.thinking ?? { effort: "medium" }, apiKey: request.apiKey, getApiKey: request.getApiKey };
		this.usedTokens = this.estimateRequestUsage(request.context, key);
		// A forced recovery already compacted this exact history; don't summarize it again
		// before giving the model a chance to produce a new response.
		if (this.justCompacted?.length === request.context.messages.length && this.justCompacted.every((message, index) => message === request.context.messages[index])) return undefined;
		if (!shouldCompact(this.usedTokens, request.model.contextWindow, DEFAULT_COMPACTION_SETTINGS)) return undefined;
		try {
			const messages = await this.compactContext(request.context, signal, this.requestSettings);
			return messages ? { ...request.context, messages } : undefined;
		} catch (error) {
			this.preparationFailed = true;
			throw error;
		}
	}

	abort(): void {
		this.promptController?.abort();
		this.compactionController?.abort();
		this.agent.abort();
	}

	subscribe(listener: (event: HarnessEvent, signal: AbortSignal) => Promise<void> | void): () => void {
		const unsubscribe = this.agent.subscribe(listener);
		this.displayListeners.add(listener);
		return () => { unsubscribe(); this.displayListeners.delete(listener); };
	}

	getDisplayState(): HarnessDisplayState {
		return { modelName: this.agent.state.model?.name ?? "模型未配置", thinking: { ...this.agent.state.thinking },
			contextUsed: this.usedTokens, contextWindow: this.agent.state.model?.contextWindow, sessionTitle: this.session.header.name ?? "新会话" };
	}
	getSessionMessages(): readonly AgentMessage[] { return structuredClone(this.agent.state.messages); }
	getSessionHistory(): readonly SessionEntry[] { return structuredClone(this.session.entries); }
	setBeforeToolCall(handler: (context: BeforeToolCallContext, signal?: AbortSignal) => Promise<BeforeToolCallResult | undefined>): () => void {
		const previous = this.agent.beforeToolCall;
		const combined = async (context: BeforeToolCallContext, signal?: AbortSignal) => {
			const result = await previous?.(context, signal);
			return result?.block ? result : handler(context, signal);
		};
		this.agent.beforeToolCall = combined;
		return () => { if (this.agent.beforeToolCall === combined) this.agent.beforeToolCall = previous; };
	}
	private async emitDisplay(event: HarnessEvent, signal: AbortSignal): Promise<void> {
		for (const listener of this.displayListeners) await listener(event, signal);
	}

	newSession(): void {
		this.assertIdle();
		this.agent.reset();
		this.usedTokens = 0;
		this.usageBaseline = undefined;
		this.justCompacted = undefined;
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
		this.usageBaseline = undefined;
		this.justCompacted = undefined;
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
		this.usageBaseline = undefined;
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
		if (this.promptController || this.agent.state.isStreaming || this.compactionController) {
			throw new Error("Cannot compact while the agent is processing");
		}
		return Boolean(await this.compactContext(this.liveContext(), undefined, this.createRequestSettings(false), { customInstructions }));
	}

	/** Called only while idle or at the loop's request boundary, after a complete tool batch. */
	private async compactContext(context: AgentContext, parentSignal: AbortSignal | undefined, request: ModelRequestSettings,
		options: { customInstructions?: string; replacesError?: boolean } = {}): Promise<AgentMessage[] | undefined> {
		if (this.compactionController) throw new Error("Cannot compact while compaction is processing");
		const messages = context.messages;
		const retainedBudget = Math.max(0, Math.floor((request.model.contextWindow - DEFAULT_COMPACTION_SETTINGS.reserveTokens) / 2));
		let cutIndex = findCutIndex(messages, Math.min(DEFAULT_COMPACTION_SETTINGS.keepRecentTokens, retainedBudget));
		if (cutIndex === 0) {
			return undefined;
		}
		// Keep this submission verbatim even when earlier tool rounds in the same task
		// are summarized. This is the original user message, never a previous summary.
		const task = this.activeUserMessage;
		const retained = (index: number) => {
			const tail = messages.slice(index);
			return task && messages.includes(task) && !tail.includes(task) ? [task, ...tail] : tail;
		};
		let keptMessages = retained(cutIndex);
		const originalTokens = estimateMessagesTokens(messages);
		if (estimateMessagesTokens(keptMessages) >= originalTokens || estimateMessagesTokens(keptMessages) > retainedBudget) {
			// One large completed tool round may itself exceed the tail budget. Summarize
			// the whole round rather than leaving orphaned calls or dropping half a batch.
			cutIndex = messages.length;
			keptMessages = retained(cutIndex);
		}
		if (estimateMessagesTokens(keptMessages) >= originalTokens) return undefined;
		const controller = new AbortController();
		const signal = parentSignal ? AbortSignal.any([parentSignal, controller.signal]) : controller.signal;
		this.compactionController = controller;
		this.usedTokens = this.estimateRequestUsage(context, this.requestKey ?? "");
		const tokensBefore = this.usedTokens;
		try {
			signal.throwIfAborted();
			await this.emitDisplay({ type: "compaction_start", tokensBefore }, signal);
			const converted = await this.agent.convertToLlm(messages);
			signal.throwIfAborted();
			const summary = await summarizeConversation({
				streamFn: this.agent.streamFunction,
				model: request.model,
				context: {
					systemPrompt: context.systemPrompt,
					messages: converted,
					tools: context.tools,
				},
				getApiKey: request.getApiKey,
				thinking: request.thinking,
				reserveTokens: DEFAULT_COMPACTION_SETTINGS.reserveTokens,
				customInstructions: options.customInstructions,
				signal,
			});
			// Even an injected provider that ignores cancellation must not commit an aborted summary.
			signal.throwIfAborted();
			const headerTime = Date.parse(this.session.header.timestamp);
			const replacement = (kept: AgentMessage[]) => {
				const wrappedSummary = buildCompactSummaryMessage(summary, {
					transcriptPath: this.session.path, recentMessagesPreserved: kept.length > 0,
					suppressFollowup: Boolean(this.promptController),
				});
				const compactedMessages: AgentMessage[] = [{
					role: "user" as const,
					content: [{ type: "text" as const, text: wrappedSummary }],
					timestamp: Number.isNaN(headerTime) ? 0 : headerTime,
				}, ...kept];
				return { wrappedSummary, compactedMessages };
			};
			let next = replacement(keptMessages);
			if (estimateMessagesTokens(next.compactedMessages) >= originalTokens) {
				// The summary covers the full history; include complete retained groups
				// in it too when the tail would otherwise prevent any token saving.
				keptMessages = retained(messages.length);
				next = replacement(keptMessages);
			}
			const { wrappedSummary, compactedMessages } = next;
			if (estimateMessagesTokens(compactedMessages) >= originalTokens) throw new Error("Compaction did not reduce the context.");
			appendEntry(this.session, {
				type: "compaction",
				summary: wrappedSummary,
				keptMessages,
				tokensBefore: this.usedTokens,
				...(options.replacesError ? { replacesError: true } : {}),
			});
			this.agent.state.messages = compactedMessages;
			this.usageBaseline = undefined;
			this.justCompacted = compactedMessages;
			this.usedTokens = estimateMessagesTokens(compactedMessages);
			await this.emitDisplay({ type: "compaction_end", tokensBefore, tokensAfter: this.usedTokens, summary: wrappedSummary }, signal);
			return compactedMessages;
		} catch (error) {
			await this.emitDisplay({ type: "compaction_error", message: error instanceof Error ? error.message : String(error) }, signal);
			throw error;
		} finally {
			this.compactionController = undefined;
		}
	}
}
