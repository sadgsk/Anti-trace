import type { Harness } from "../../harness/harness.ts";
import type { SessionListItem } from "../../harness/session.ts";
import type { AgentEvent, AgentMessage } from "../../types.ts";
import { preparePromptSubmission, type PromptDraft } from "../input/prompt-draft.ts";
import { previewToolResult } from "../render.ts";
import type { ByokRuntime } from "../byok-runtime.ts";
import { ByokConfigError } from "../../config/errors.ts";

export type ReplHarness = Pick<Harness, "prompt" | "abort" | "subscribe" | "newSession"
	| "listSessions" | "resumeAt" | "setContextWindow" | "contextUsage" | "manualCompact">;

export interface ReplEntry { readonly id: number; readonly text: string; readonly kind?: "user" }
export interface ReplSnapshot {
	readonly entries: readonly ReplEntry[];
	readonly liveText: string;
	readonly busy: boolean;
	readonly closed: boolean;
	readonly resumeChoices: readonly SessionListItem[] | null;
	readonly error?: string;
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
	private streamedMessage = false;
	private disposed = false;

	constructor(private readonly options: ReplOptions) {
		this.harness = options.harness;
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
			const line = text.trim();
			const command = !/[\r\n]/u.test(text) ? /^\/(exit|new|resume|context|compact|help|reload|config|model)(?:\s+(.*))?$/u.exec(line) : null;
			if (command && !(command[1] === "resume" && command[2] !== undefined)) {
				await this.runCommand(command[1]!, command[2] ?? "");
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
			if (!this.snapshot.closed) this.update({ busy: false });
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

	write(text: string, kind?: "user"): void {
		if (!this.snapshot.closed) this.update({ entries: [...this.snapshot.entries, { id: this.nextId++, text, kind }] });
	}

	writeContext(): void {
		const { used, window } = this.harness.contextUsage();
		this.write(`ctx ${used}/${window ?? "未配置"}`);
	}

	private async runCommand(command: string, argument: string): Promise<void> {
		if (!["context", "config", "model"].includes(command) && argument.length > 0) {
			this.write(`用法：/${command}`);
			return;
		}
		if (command === "exit") { this.exit(); return; }
		if (command === "help") {
			this.write("/exit 退出 · /new 新会话 · /resume 恢复会话 · /context [窗口] · /compact 压缩上下文");
			this.write("/config [路径] 查看或更换 BYOK 配置 · /reload 重载配置 · /model <模型键> 选择模型（仅本次运行）");
			this.write("Enter 提交 · Shift/Alt+Enter 换行 · Ctrl+Z 撤销 · Ctrl+Shift+Z 重做 · Ctrl+C 中断/清空 · Ctrl+D 退出");
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
		const result = byok.reload(command === "config" ? { configPath: argument, model: undefined }
			: command === "model" ? { model: argument } : {});
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
		this.writeContext();
	}

	private handleEvent(event: AgentEvent): void {
		if (this.disposed || this.snapshot.closed) return;
		switch (event.type) {
			case "message_start":
				if (event.message.role === "assistant") this.streamedMessage = false;
				break;
			case "message_update":
				if (event.assistantMessageEvent.type === "text_delta") {
					this.streamedMessage = true;
					this.update({ liveText: this.snapshot.liveText + event.assistantMessageEvent.delta });
				}
				break;
			case "message_end":
				if (event.message.role === "assistant") {
					if (!this.streamedMessage) {
						const text = event.message.content.filter(block => block.type === "text").map(block => block.text).join("");
						if (text) this.update({ liveText: this.snapshot.liveText + text });
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

	private flushLive(): void {
		if (this.snapshot.liveText && !this.snapshot.closed) {
			this.update({ entries: [...this.snapshot.entries, { id: this.nextId++, text: this.snapshot.liveText }], liveText: "" });
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
