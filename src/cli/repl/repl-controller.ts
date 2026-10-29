import type { Harness } from "../../harness/harness.ts";
import type { SessionListItem } from "../../harness/session.ts";
import type { AgentEvent, AgentMessage, ThinkingLevel } from "../../types.ts";
import { THINKING_LEVELS } from "../../llm/rules.ts";
import { preparePromptSubmission, type PromptDraft } from "../input/prompt-draft.ts";
import { previewToolResult } from "../render.ts";
import type { ByokRuntime } from "../byok-runtime.ts";
import { ByokConfigError } from "../../config/errors.ts";
import { SLASH_COMMANDS, commandUsage, parseSlashCommand, type SlashCommandDefinition } from "../commands/command-registry.ts";

export type ReplHarness = Pick<Harness, "prompt" | "abort" | "subscribe" | "newSession"
	| "listSessions" | "resumeAt" | "setContextWindow" | "contextUsage" | "manualCompact">
	& Partial<Pick<Harness, "setThinkingLevel" | "setThinkingEnabled" | "describeSettings" | "settingsWarning">>;

export interface ReplEntry { readonly id: number; readonly text: string; readonly kind?: "user" | "thinking" }
export interface ReplSnapshot {
	readonly entries: readonly ReplEntry[];
	readonly liveText: string;
	readonly busy: boolean;
	readonly closed: boolean;
	readonly resumeChoices: readonly SessionListItem[] | null;
	readonly error?: string;
	readonly modelStatus?: string;
	readonly liveKind?: "thinking";
}

export interface ReplOptions {
	harness: ReplHarness;
	byok?: ByokRuntime;
	/** Runs synchronously once a draft is accepted; the editor clears that draft here. */
	onAccept?: () => void;
	onExit?: () => void;
}

/** Commands and agent events consume complete drafts, never raw terminal input. */
export class ReplController {
	private snapshot: ReplSnapshot = { entries: [], liveText: "", busy: false, closed: false, resumeChoices: null };
	private readonly listeners = new Set<() => void>();
	private readonly unsubscribe: () => void;
	private readonly harness: ReplHarness;
	private nextId = 1;
	private showThinking = true;
	private readonly streamedBlocks = new Set<number>();
	private disposed = false;

	constructor(private readonly options: ReplOptions) {
		this.harness = options.harness;
		this.snapshot = { ...this.snapshot, modelStatus: this.harness.describeSettings?.() };
		this.unsubscribe = this.harness.subscribe(event => this.handleEvent(event));
	}

	getSnapshot = (): ReplSnapshot => this.snapshot;
	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => { this.listeners.delete(listener); };
	};

	canSubmit(draft?: PromptDraft): boolean {
		if (this.disposed || this.snapshot.closed || this.snapshot.busy) return false;
		if (!draft || this.snapshot.resumeChoices !== null) return true;
		const { text, images } = preparePromptSubmission(draft);
		return text.trim().length > 0 || images.length > 0;
	}

	/** Expand references once, then route one accepted snapshot to a command or Harness. */
	async submit(draft: PromptDraft): Promise<boolean> {
		if (!this.canSubmit(draft)) return false;
		const { text, images } = preparePromptSubmission(draft);
		this.update({ busy: true, error: undefined });
		try {
			this.options.onAccept?.();
			if (this.snapshot.closed) return true;
			if (this.snapshot.resumeChoices !== null) {
				this.resumeSelection(text);
				return true;
			}
			const parsed = parseSlashCommand(text);
			if (parsed) {
				await this.runCommand(parsed.command, parsed.argument);
			} else {
				this.write(`> ${draft.text}`, "user");
				await this.harness.prompt(text, images.length > 0 ? images : undefined);
				if (!this.snapshot.closed) this.writeContext();
			}
		} catch (error) {
			if (!this.snapshot.closed) {
				const message = error instanceof Error ? error.message : String(error);
				this.update({ error: message });
				this.write(`错误：${message}`);
			}
		} finally {
			this.flushLive();
			if (!this.snapshot.closed) this.update({ busy: false, modelStatus: this.harness.describeSettings?.() });
		}
		return true;
	}

	interrupt(): void {
		if (!this.snapshot.closed && this.snapshot.busy) this.harness.abort();
	}

	exit(): void {
		if (this.snapshot.closed) return;
		this.flushLive();
		this.update({ closed: true, busy: false, resumeChoices: null });
		try { this.dispose(); }
		finally { this.options.onExit?.(); }
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.unsubscribe();
		this.listeners.clear();
		this.snapshot = { ...this.snapshot, closed: true, busy: false, resumeChoices: null };
		this.harness.abort();
	}

	write(text: string, kind?: "user" | "thinking"): void {
		if (!this.snapshot.closed) this.update({ entries: [...this.snapshot.entries, { id: this.nextId++, text, kind }] });
	}

	writeContext(): void {
		const { used, window } = this.harness.contextUsage();
		this.write(`ctx ${used}/${window ?? "未配置"}`);
	}

	private async runCommand(definition: SlashCommandDefinition, argument: string): Promise<void> {
		const command = definition.name;
		if (!definition.argumentHint && argument.length > 0) {
			this.write(`用法：${commandUsage(definition)}`);
			return;
		}
		if (command === "exit") { this.exit(); return; }
		if (command === "help") {
			for (const item of SLASH_COMMANDS) this.write(`${commandUsage(item)} · ${item.description}`);
			this.write("输入 / 打开命令菜单 · ↑↓ 选择 · Enter 确认 · Tab 补全 · Esc 收起");
			this.write("Enter 提交 · Shift/Alt+Enter 换行 · Ctrl+Z 撤销 · Ctrl+Shift+Z 重做 · Ctrl+C 中断/清空 · Ctrl+D 退出");
			return;
		}
		if (command === "thinking-display") {
			if (argument && !["on", "off"].includes(argument)) { this.write("用法：/thinking-display [on|off]"); return; }
			if (argument) this.showThinking = argument === "on";
			this.write(`思考文字显示：${this.showThinking ? "开启" : "关闭"}。`);
			return;
		}
		if (command === "thinking" || command === "effort") {
			if (!this.harness.setThinkingEnabled || !this.harness.setThinkingLevel) throw new ByokConfigError("当前入口未提供思考设置。");
			if (argument) {
				if (command === "thinking") {
					if (!["on", "off", "default"].includes(argument)) { this.write("用法：/thinking [on|off|default]"); return; }
					this.harness.setThinkingEnabled(argument === "default" ? undefined : argument === "on");
				} else {
					if (!THINKING_LEVELS.includes(argument as ThinkingLevel)) { this.write("用法：/effort [low|medium|high|xhigh|max]"); return; }
					this.harness.setThinkingLevel(argument as ThinkingLevel);
				}
			}
			this.write(this.harness.describeSettings?.() ?? "");
			if (command === "effort") this.write("档位：low / medium / high / xhigh / max；关闭或使用服务端默认时仍保存所选档位。");
			return;
		}
		if (["reload", "config", "model"].includes(command)) {
			this.configureByok(command, argument);
			return;
		}
		const harness = this.harness;
		switch (command) {
			case "new":
				harness.newSession();
				this.write("已开始新会话。");
				this.writeContext();
				break;
			case "resume": {
				const choices = harness.listSessions();
				if (choices.length === 0) { this.write("没有可恢复的会话。"); break; }
				this.update({ resumeChoices: choices.map(item => ({ ...item })) });
				choices.forEach((item, index) => this.write(`${index + 1}. ${item.name}  ${this.formatTime(item.lastOpenedAt)}`));
				this.write("输入会话序号，空行取消。");
				break;
			}
			case "context":
				if (argument) {
					const tokens = Number(argument);
					if (!/^\d+$/u.test(argument) || !Number.isSafeInteger(tokens) || tokens <= 0) {
						this.write("用法：/context <正整数>");
						break;
					}
					harness.setContextWindow(tokens);
				}
				this.writeContext();
				break;
			case "compact": {
				const result = await harness.manualCompact();
				if (result === "below-threshold") this.write("上下文用量未超过窗口的 1/4，暂不压缩。");
				else if (result === "nothing-to-compact") this.write("没有可压缩的旧内容。");
				else this.write("上下文已压缩。");
				this.writeContext();
				break;
			}
		}
	}

	private configureByok(command: string, argument: string): void {
		const byok = this.options.byok;
		if (!byok) { this.write("当前会话未使用 BYOK 配置入口。"); return; }
		if (command === "config" && !argument) { this.write(byok.describe()); return; }
		if (command === "model" && !argument) {
			this.write("用法：/model <模型键>（对应配置文件 models 中的键）");
			const modelKeys = byok.modelKeys;
			this.write(modelKeys.length > 0 ? `已加载模型键：${modelKeys.join("、")}`
				: "暂无已加载的模型，请先加载有效配置；/config 查看详情。");
			return;
		}
		const result = command === "model" ? byok.selectModel(argument)
			: byok.reload(command === "config" ? { configPath: argument, model: undefined } : {});
		if (!result.ok) throw new ByokConfigError(command === "model" ? `${result.reason}\n/config 查看详情。` : result.message);
		if (command === "model") {
			this.write(`已切换到 ${argument}。`);
			for (const warning of result.warnings) this.write(warning);
			return;
		}
		this.write(result.message);
		this.writeContext();
	}

	private resumeSelection(text: string): void {
		const choices = this.snapshot.resumeChoices!;
		if (text.trim() === "") {
			this.update({ resumeChoices: null });
			this.write("已取消恢复会话。");
			return;
		}
		const selected = /^\d+$/u.test(text.trim()) ? choices[Number(text.trim()) - 1] : undefined;
		if (!selected) { this.write("请输入列表中的会话序号，或空行取消。"); return; }
		// Find the selected file again: mtime sorting can change while the chooser is open.
		const harness = this.harness;
		const currentIndex = harness.listSessions().findIndex(item => item.filePath === selected.filePath);
		if (currentIndex < 0 || !harness.resumeAt(currentIndex + 1)) {
			this.write("该会话已不可用，请重新选择。");
			return;
		}
		this.update({ resumeChoices: null });
		this.write(`已恢复会话：${selected.name}`);
		if (harness.settingsWarning) this.write(harness.settingsWarning);
		if (harness.describeSettings) this.write(harness.describeSettings());
		this.writeContext();
	}

	private handleEvent(event: AgentEvent): void {
		if (this.disposed || this.snapshot.closed) return;
		switch (event.type) {
			case "message_start":
				if (event.message.role === "assistant") {
					this.streamedBlocks.clear();
				}
				break;
			case "message_update":
				if (event.assistantMessageEvent.type === "text_delta" || event.assistantMessageEvent.type === "thinking_delta") {
					const delta = event.assistantMessageEvent;
					this.streamedBlocks.add(delta.contentIndex);
					this.appendLive(delta.delta, delta.type === "thinking_delta");
				}
				break;
			case "message_end":
				if (event.message.role === "assistant") {
					for (const [index, block] of event.message.content.entries()) {
						if (this.streamedBlocks.has(index)) continue;
						if (block.type === "text") this.appendLive(block.text, false);
						else if (block.type === "thinking") this.appendLive(block.thinking, true);
					}
					this.flushLive();
				}
				break;
			case "tool_execution_start":
				this.flushLive();
				this.write(`[${event.toolName}] running`);
				break;
			case "tool_execution_end": {
				const preview = previewToolResult(event.result);
				this.write(`[${event.toolName}] ${event.isError ? "error" : "ok"}${preview ? `: ${preview}` : ""}`);
				break;
			}
			case "turn_end": this.flushLive(); break;
			case "agent_end": {
				this.flushLive();
				const assistant = [...event.messages].reverse().find((message): message is Extract<AgentMessage, { role: "assistant" }> => message.role === "assistant");
				if (assistant && (assistant.errorMessage || assistant.stopReason === "error" || assistant.stopReason === "aborted")) {
					const message = assistant.errorMessage ?? (assistant.stopReason === "aborted" ? "已中断。" : "请求失败。");
					this.update({ error: message });
					this.write(message);
				}
				break;
			}
		}
	}

	private appendLive(text: string, thinking: boolean): void {
		if (!text || (thinking && !this.showThinking)) return;
		const kind = thinking ? "thinking" : undefined;
		if (this.snapshot.liveText && this.snapshot.liveKind !== kind) this.flushLive();
		this.update({ liveKind: kind, liveText: this.snapshot.liveText + (thinking && !this.snapshot.liveText ? "[思考] " : "") + text });
	}

	private flushLive(): void {
		if (this.snapshot.liveText && !this.snapshot.closed) {
			this.update({ entries: [...this.snapshot.entries, { id: this.nextId++, text: this.snapshot.liveText, kind: this.snapshot.liveKind }], liveText: "", liveKind: undefined });
		}
	}

	private update(change: Partial<ReplSnapshot>): void {
		this.snapshot = { ...this.snapshot, ...change };
		for (const listener of this.listeners) listener();
	}

	private formatTime(timestamp: number): string {
		const date = new Date(timestamp);
		const pad = (value: number) => String(value).padStart(2, "0");
		return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
	}
}
