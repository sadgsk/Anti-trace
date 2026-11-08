import type { Harness, HarnessEvent, HarnessDisplayState } from "../../harness/harness.ts";
import type { SessionListItem } from "../../harness/session.ts";
import type { AgentMessage, ThinkingLevel } from "../../types.ts";
import { THINKING_LEVELS } from "../../llm/rules.ts";
import { preparePromptSubmission, type PromptDraft } from "../input/prompt-draft.ts";
import { previewToolResult } from "../render.ts";
import type { ByokRuntime } from "../byok-runtime.ts";
import { ByokConfigError } from "../../config/errors.ts";
import { SLASH_COMMANDS, commandUsage, parseSlashCommand, type SlashCommandDefinition } from "../commands/command-registry.ts";
import { PermissionPolicy, type PermissionMode } from "../permissions/permission-policy.ts";
import { projectMessages, projectSessionHistory, type TranscriptItem, type AssistantTurnItem, type NoticeTone } from "../../tui/transcript.ts";
import { CommandDialogController } from "../../tui/commands/command-dialog-controller.ts";
import type { ProfileEdit } from "../../config/config-profiles.ts";
import { UiLocale, type UiLanguage } from "../locale.ts";
import type { TranscriptAnchor, ViewportMetrics } from "../../tui/viewport-state.ts";

export type ReplHarness = Pick<Harness, "prompt" | "abort" | "subscribe" | "newSession"
	| "listSessions" | "resumeAt" | "setContextWindow" | "contextUsage" | "manualCompact">
	& Partial<Pick<Harness, "setThinkingLevel" | "setThinkingEnabled" | "describeSettings" | "settingsWarning"
		| "getDisplayState" | "getSessionMessages" | "getSessionHistory" | "setBeforeToolCall">>;

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
	readonly transcript: readonly TranscriptItem[];
	readonly activeItems: readonly TranscriptItem[];
	readonly expanded: boolean;
	readonly thinkingDisplay: boolean;
	readonly renderEpoch: number;
	readonly display: HarnessDisplayState;
	readonly phase: "thinking" | "streaming" | "tool" | "compacting";
	readonly startedAt: number;
	readonly lastEventAt: number;
	readonly outputChars: number;
	readonly scrollOffset: number;
	readonly historyVersion: number;
	readonly viewingHistory: boolean;
	readonly reviewAnchor?: TranscriptAnchor;
}

export interface ReplOptions {
	harness: ReplHarness;
	byok?: ByokRuntime;
	cwd?: string;
	interactive?: boolean;
	permissionMode?: PermissionMode;
	/** Runs synchronously once a draft is accepted; the editor clears that draft here. */
	onAccept?: () => void;
	onExit?: () => void;
}

/** Commands and agent events consume complete drafts, never raw terminal input. */
export class ReplController {
	private snapshot: ReplSnapshot = { entries: [], liveText: "", busy: false, closed: false, resumeChoices: null,
		transcript: [], activeItems: [], expanded: false, thinkingDisplay: true, renderEpoch: 0,
		display: { modelName: "模型未配置", thinking: { effort: "medium" }, contextUsed: 0, sessionTitle: "新会话" },
		phase: "thinking", startedAt: 0, lastEventAt: 0, outputChars: 0, scrollOffset: 0, historyVersion: 0, viewingHistory: false };
	private scrollLimit = Number.MAX_SAFE_INTEGER;
	private viewportAnchor?: TranscriptAnchor;
	private lastToolAnchor?: TranscriptAnchor;
	private readonly listeners = new Set<() => void>();
	private readonly unsubscribe: () => void;
	private readonly harness: ReplHarness;
	private nextId = 1;
	private showThinking = true;
	private readonly streamedBlocks = new Set<number>();
	private disposed = false;
	readonly permissions: PermissionPolicy;
	readonly dialogs = new CommandDialogController();
	readonly locale: UiLocale;
	private readonly unsubscribeLocale: () => void;
	private readonly unsubscribeDialogs: () => void;
	private readonly restorePermissionHook?: () => void;
	private assistantId?: number;
	private interrupted = false;
	private promptResultReceived = false;

	constructor(private readonly options: ReplOptions) {
		this.locale = new UiLocale(options.cwd ?? process.cwd(), options.interactive ?? false);
		this.unsubscribeLocale = this.locale.subscribe(() => this.update({ renderEpoch: this.snapshot.renderEpoch + 1 }));
		this.harness = options.harness;
		this.permissions = new PermissionPolicy(options.cwd ?? process.cwd(), options.interactive ?? false, options.permissionMode);
		this.restorePermissionHook = this.harness.setBeforeToolCall?.(this.permissions.beforeToolCall);
		this.snapshot = { ...this.snapshot, modelStatus: this.harness.describeSettings?.(), display: this.readDisplay() };
		this.unsubscribe = this.harness.subscribe(event => this.handleEvent(event));
		this.unsubscribeDialogs = this.dialogs.subscribe(() => this.update({}));
	}

	getSnapshot = (): ReplSnapshot => this.snapshot;
	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => { this.listeners.delete(listener); };
	};

	canSubmit(draft?: PromptDraft): boolean {
		if (this.disposed || this.snapshot.closed || this.snapshot.busy || this.dialogs.getSnapshot()) return false;
		if (!draft || this.snapshot.resumeChoices !== null) return true;
		const { text, images } = preparePromptSubmission(draft);
		return text.trim().length > 0 || images.length > 0;
	}

	/** Expand references once, then route one accepted snapshot to a command or Harness. */
	async submit(draft: PromptDraft): Promise<boolean> {
		if (!this.canSubmit(draft)) return false;
		this.interrupted = false;
		this.promptResultReceived = false;
		const { text, images } = preparePromptSubmission(draft);
		this.update({ busy: true, error: undefined, expanded: false, scrollOffset: 0, viewingHistory: false, reviewAnchor: undefined, phase: "thinking", startedAt: Date.now(), lastEventAt: Date.now(), outputChars: 0 });
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
				this.write(`> ${draft.text}`, "user", "info", false, draft.references.map(ref => ref.label));
				await this.harness.prompt(text, images.length > 0 ? images : undefined);
				if (!this.snapshot.closed) this.writeContext();
			}
		} catch (error) {
			if (!this.snapshot.closed) {
				const message = error instanceof Error ? error.message : String(error);
				// Suppress only the error already reported by prompt_end. A different
				// exception (for example from another subscriber) still needs reporting.
				if (!this.promptResultReceived || this.snapshot.error !== message) {
					this.update({ error: message });
					this.write(`错误：${message}`, undefined, "error");
				}
			}
		} finally {
			this.flushLive();
			this.assistantId = undefined;
			if (!this.snapshot.closed) this.update({ busy: false, modelStatus: this.harness.describeSettings?.(), display: this.readDisplay(),
				transcript: [...this.snapshot.transcript, ...this.snapshot.activeItems], activeItems: [] });
		}
		return true;
	}

	interrupt(): void {
		if (!this.snapshot.closed && this.snapshot.busy) {
			if (!this.interrupted) this.write("已中断。可以修改要求后继续。", undefined, "warning");
			this.interrupted = true; this.harness.abort(); this.permissions.cancel();
		}
	}
	toggleExpanded(): void {
		if (this.snapshot.closed || this.dialogs.getSnapshot() || this.permissions.getSnapshot().request) return;
		// Native scrollback cannot be edited in place. Inspect the live transcript, keeping the message in view.
		const anchor = this.snapshot.viewingHistory ? this.viewportAnchor : this.lastToolAnchor ?? this.viewportAnchor;
		this.update({ expanded: this.snapshot.viewingHistory ? !this.snapshot.expanded : true, viewingHistory: true, reviewAnchor: anchor, renderEpoch: this.snapshot.renderEpoch + 1 });
	}
	scroll(lines: number): void {
		const scrollOffset = Math.min(this.scrollLimit, Math.max(0, this.snapshot.scrollOffset + lines));
		if (!scrollOffset && lines > 0 && !this.scrollLimit) return;
		this.update({ scrollOffset, expanded: scrollOffset > 0 && this.snapshot.expanded, viewingHistory: scrollOffset > 0, reviewAnchor: undefined });
	}
	returnToLatest(): void { this.update({ expanded: false, scrollOffset: 0, viewingHistory: false, reviewAnchor: undefined, renderEpoch: this.snapshot.renderEpoch + 1 }); }
	setScrollLimit = (limit: number): void => { this.scrollLimit = limit; if (this.snapshot.scrollOffset > limit) this.update({ scrollOffset: limit }); };
	setViewportMetrics = (metrics: ViewportMetrics): void => {
		this.scrollLimit = metrics.limit; this.viewportAnchor = metrics.anchor; this.lastToolAnchor = metrics.lastTool;
		// A scheduled layout may finish after another wheel event. Never overwrite newer user input.
		if (this.snapshot.viewingHistory && this.snapshot.scrollOffset !== metrics.offset
			&& (metrics.requestedOffset === undefined || metrics.requestedOffset === this.snapshot.scrollOffset)) this.update({ scrollOffset: metrics.offset });
	};
	private readDisplay(): HarnessDisplayState {
		const usage = this.harness.contextUsage();
		return this.harness.getDisplayState?.() ?? { ...this.snapshot.display, contextUsed: usage.used, contextWindow: usage.window };
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
		this.unsubscribeDialogs();
		this.unsubscribeLocale();
		this.dialogs.dispose();
		this.permissions.dispose();
		this.restorePermissionHook?.();
		this.listeners.clear();
		this.snapshot = { ...this.snapshot, closed: true, busy: false, resumeChoices: null };
		this.harness.abort();
	}

	write(text: string, kind?: "user" | "thinking", tone: NoticeTone = "info", textOnly = false, attachments: string[] = []): void {
		if (this.snapshot.closed) return;
		const id = this.nextId++;
		const item: TranscriptItem = kind === "user" ? { id, kind: "user", text: text.replace(/^> /, ""), attachments, timestamp: Date.now() }
			: { id, kind: "notice", text, tone };
		this.update({ entries: [...this.snapshot.entries, { id, text: kind ? text : this.locale.t(text), kind }],
			...(textOnly ? {} : this.snapshot.busy && kind !== "user" ? { activeItems: [...this.snapshot.activeItems, item] }
				: { transcript: [...this.snapshot.transcript, item] }) });
	}

	writeContext(visible = false): void {
		const { used, window } = this.harness.contextUsage();
		this.write(`ctx ${used}/${window ?? "未配置"}`, undefined, "info", !visible);
		this.update({ display: this.readDisplay() });
	}

	private async runCommand(definition: SlashCommandDefinition, argument: string): Promise<void> {
		const command = definition.name;
		if (command === "language" && !argument && !this.options.interactive) { this.write(`language ${this.locale.getSnapshot()}`); return; }
		if (command === "language" && argument) {
			if (argument !== "zh" && argument !== "en") { this.write("用法：/language [zh|en]"); return; }
			this.locale.setLanguage(argument); this.write("语言已切换。"); return;
		}
		if (this.options.interactive && !argument && this.openCommandDialog(command)) return;
		if (!definition.argumentHint && argument.length > 0) {
			this.write(`用法：${commandUsage(definition)}`);
			return;
		}
		if (command === "exit") { this.exit(); return; }
		if (command === "help") {
			this.write([...SLASH_COMMANDS.map(item => `${commandUsage(item)} · ${item.description}`), "",
				"输入 / 打开命令菜单 · ↑↓ 选择 · Enter 确认 · Tab 补全 · Esc 收起",
				"Enter 提交 · Shift/Alt+Enter 换行 · Ctrl+Z 撤销 · Ctrl+Shift+Z 重做 · Ctrl+C 中断/清空 · Ctrl+D 退出",
				"Ctrl+O 展开/收起 · Shift+Tab 切换权限模式 · @ 搜索工作区文件 · 审批时 1/2/3 选择",
				"滚轮 / PgUp/PgDn 回看 · Ctrl+End 回到最新 · Shift+拖动选择文字"].join("\n"));
			return;
		}
		if (command === "thinking-display") {
			if (argument && !["on", "off"].includes(argument)) { this.write("用法：/thinking-display [on|off]"); return; }
			if (argument) {
				this.showThinking = argument === "on";
				this.update({ thinkingDisplay: this.showThinking, renderEpoch: this.snapshot.renderEpoch + 1 });
			}
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
				this.permissions.resetSession();
				this.update({ transcript: [], activeItems: [], renderEpoch: this.snapshot.renderEpoch + 1 });
				this.write("已开始新会话。");
				this.writeContext();
				break;
			case "resume": {
				const choices = harness.listSessions();
				if (choices.length === 0) { this.write("没有可恢复的会话。"); break; }
				this.update({ resumeChoices: choices.map(item => ({ ...item })) });
				this.write([...choices.map((item, index) => `${index + 1}. ${item.name}  ${this.formatTime(item.lastOpenedAt)}`), "输入会话序号，空行取消。"].join("\n"));
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
				this.writeContext(true);
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

	private dialogAction(action: () => void): void {
		action();
		this.dialogs.close();
		this.update({ display: this.readDisplay(), modelStatus: this.harness.describeSettings?.() });
	}

	private openCommandDialog(command: string): boolean {
		if (command === "language") {
			this.dialogs.openPicker({ title: "选择语言", description: "切换 CLI 界面语言，不改变对话内容。", choices: [{ id: "zh", label: "中文", literal: true, current: this.locale.getSnapshot() === "zh" }, { id: "en", label: "English", literal: true, current: this.locale.getSnapshot() === "en" }],
				onAccept: id => this.dialogAction(() => { this.locale.setLanguage(id as UiLanguage); this.write("语言已切换。"); }) }); return true;
		}
		if (command === "model") {
			const byok = this.options.byok;
			if (!byok) throw new ByokConfigError("当前入口未提供模型配置。");
			this.dialogs.openPicker({ title: "选择模型", description: "来自当前配置；确认后使用并记住，下次启动自动恢复。", choices: byok.modelChoices.map(item => ({ ...item, literal: true, descriptionLiteral: true })),
				onAccept: id => this.dialogAction(() => this.configureByok("model", id)) });
			return true;
		}
		if (command === "effort" || command === "thinking" || command === "thinking-display") {
			const display = this.readDisplay();
			if (command === "effort") {
				this.dialogs.openPicker({ title: "思考等级 Effort", description: "从快到强：low → medium → high → xhigh → max", horizontal: true,
					choices: THINKING_LEVELS.map(id => ({ id, label: id, current: id === display.thinking.effort })),
					onAccept: id => this.dialogAction(() => { if (!this.harness.setThinkingLevel) throw new ByokConfigError("当前入口不支持设置思考等级。"); this.harness.setThinkingLevel(id as ThinkingLevel); this.write(`思考等级已设为 ${id}。`); }) });
			} else {
				const showing = command === "thinking-display", enabled = showing ? this.showThinking : display.thinking.enabled;
				this.dialogs.openPicker({ title: showing ? "思考文字展示" : "模型思考开关",
					description: showing ? "仅控制思考文字的默认展开；Ctrl+O 仍可展开查看。" : `控制模型是否启用思考；当前${enabled === undefined ? "由服务端默认决定" : enabled ? "开启" : "关闭"}，保留 effort ${display.thinking.effort}。`,
					choices: [{ id: "on", label: "开启", current: enabled === true }, { id: "off", label: "关闭", current: enabled === false }],
					onAccept: id => this.dialogAction(() => {
						if (showing) { this.showThinking = id === "on"; this.update({ thinkingDisplay: this.showThinking, renderEpoch: this.snapshot.renderEpoch + 1 }); }
						else { if (!this.harness.setThinkingEnabled) throw new ByokConfigError("当前入口不支持设置模型思考。"); this.harness.setThinkingEnabled(id === "on"); }
						this.write(`${showing ? "思考文字展示" : "模型思考"}已${id === "on" ? "开启" : "关闭"}。`);
					}) });
			}
			return true;
		}
		if (command === "resume") {
			const choices = this.harness.listSessions();
			if (!choices.length) { this.write("没有可恢复的会话。"); return true; }
			this.dialogs.openPicker({ title: "恢复会话", description: "↑↓ 选择会话，Enter 恢复；Esc 取消。",
				choices: choices.map(item => ({ id: item.filePath, label: item.name, literal: true, description: this.formatTime(item.lastOpenedAt), descriptionLiteral: true })),
				onAccept: id => this.dialogAction(() => {
					const index = this.harness.listSessions().findIndex(item => item.filePath === id);
					if (index < 0) throw new Error("该会话已不可用，请返回后重新打开。");
					this.update({ resumeChoices: [choices.find(item => item.filePath === id)!] });
					this.resumeSelection("1");
					if (this.snapshot.resumeChoices) { this.update({ resumeChoices: null }); throw new Error("恢复失败，请重新选择。"); }
				}) });
			return true;
		}
		if (command === "config") { this.openConfigMenu(); return true; }
		return false;
	}

	private openConfigMenu(editing = false): void {
		const byok = this.options.byok;
		if (!byok) throw new ByokConfigError("当前入口未提供配置管理。");
		const profiles = byok.profiles.list(byok.configPath);
		this.dialogs.openPicker({ title: editing ? "选择要修改的配置文件" : "配置文件",
			description: editing ? "选择文件后编辑；多模型文件可继续选择模型。" : "选择已有文件即可使用；新增与修改位于同级菜单。",
			choices: [...profiles.map(item => ({ id: item.path, label: item.name, literal: true, description: item.valid ? (item.path === byok.configPath ? "当前使用" : "可用配置") : "配置无效，请先修正", current: item.path === byok.configPath })),
				...(!editing ? [{ id: ":add", label: "＋ 新增配置文件" }, { id: ":edit", label: "✎ 修改配置文件" }] : [])],
			onBack: editing ? () => this.openConfigMenu() : undefined,
			onAccept: id => {
				if (id === ":add") this.openConfigForm();
				else if (id === ":edit") this.openConfigMenu(true);
				else if (editing) this.openProfileModels(id);
				else this.dialogAction(() => this.configureByok("config", id));
			} });
	}
	private openProfileModels(path: string): void {
		const byok = this.options.byok!, edit = byok.profiles.read(path);
		this.dialogs.openPicker({ title: "管理模型", description: "选择模型编辑字段，或新增模型到此文件。",
			choices: [...Object.entries(edit.document.models).map(([id, value]) => ({ id, label: value.name ?? value.id, literal: true, description: id, descriptionLiteral: true, current: id === edit.modelKey })), { id: ":add-model", label: "＋ 新增模型" }],
			onAccept: id => this.openConfigForm(id === ":add-model" ? byok.profiles.addModel(path) : { ...edit, modelKey: id }), onBack: () => this.openConfigMenu(true) });
	}

	private openConfigForm(edit?: ProfileEdit): void {
		const byok = this.options.byok!;
		this.dialogs.openForm({ title: edit?.adding ? "新增模型" : edit ? "修改配置文件" : "新增配置文件", description: "选择字段后 Enter 编辑；完成后保存并使用。",
			fields: byok.profiles.fields(edit), onBack: () => edit ? this.openProfileModels(edit.path) : this.openConfigMenu(),
			onSave: values => this.dialogAction(() => { const warnings = byok.saveProfile(values, edit); this.write("配置已保存并生效，会话已保留。"); for (const warning of warnings) this.write(warning); }) });
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
		this.permissions.resetSession();
		this.update({ transcript: harness.getSessionHistory ? projectSessionHistory(harness.getSessionHistory(), () => this.nextId++)
			: projectMessages(harness.getSessionMessages?.() ?? [], () => this.nextId++), activeItems: [],
			renderEpoch: this.snapshot.renderEpoch + 1, historyVersion: this.snapshot.historyVersion + 1 });
		this.write(`已恢复会话：${selected.name}`);
		if (harness.settingsWarning) this.write(harness.settingsWarning);
		if (harness.describeSettings) this.write(harness.describeSettings());
		this.writeContext();
	}

	private handleEvent(event: HarnessEvent): void {
		if (this.disposed || this.snapshot.closed) return;
		this.update({ lastEventAt: Date.now() });
		switch (event.type) {
			case "message_start":
				if (event.message.role === "assistant") {
					this.streamedBlocks.clear();
					this.assistantId = this.nextId++;
					this.update({ activeItems: [...this.snapshot.activeItems, { id: this.assistantId, kind: "assistant", blocks: [], timestamp: Date.now() }] });
				}
				break;
			case "message_update":
				if (event.assistantMessageEvent.type === "text_delta" || event.assistantMessageEvent.type === "thinking_delta") {
					const delta = event.assistantMessageEvent;
					this.streamedBlocks.add(delta.contentIndex);
					this.appendLive(delta.delta, delta.type === "thinking_delta");
					const kind = delta.type === "thinking_delta" ? "thinking" : "text";
					this.update({ phase: kind === "thinking" ? "thinking" : "streaming", outputChars: this.snapshot.outputChars + delta.delta.length,
						activeItems: this.snapshot.activeItems.map(item => {
							if (item.id !== this.assistantId || item.kind !== "assistant") return item;
							const existing = item.blocks.find(block => block.index === delta.contentIndex);
							return { ...item, blocks: existing ? item.blocks.map(block => block.index === delta.contentIndex ? { ...block, text: block.text + delta.delta } : block)
								: [...item.blocks, { kind, index: delta.contentIndex, text: delta.delta }] };
						}) });
				}
				break;
			case "message_end":
				if (event.message.role === "assistant") {
					const message = event.message;
					const blocks = message.content.flatMap((block, index): AssistantTurnItem["blocks"] => block.type === "text" ? [{ kind: "text" as const, text: block.text, index }]
						: block.type === "thinking" ? [{ kind: "thinking" as const, text: block.thinking, index }] : []);
					this.update({ activeItems: this.snapshot.activeItems.map(item => item.id === this.assistantId && item.kind === "assistant"
						? { ...item, blocks, durationMs: Date.now() - item.timestamp } : item) });
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
				this.write(`[${event.toolName}] running`, undefined, "info", true);
				this.update({ phase: "tool", activeItems: [...this.snapshot.activeItems, { id: this.nextId++, kind: "tool", callId: event.toolCallId,
					name: event.toolName, args: event.args as Record<string, unknown>, status: "running", startedAt: Date.now() }] });
				break;
			case "tool_execution_update":
				this.update({ activeItems: this.snapshot.activeItems.map(item => item.kind === "tool" && item.callId === event.toolCallId
					? { ...item, partial: event.partialResult as NonNullable<Extract<TranscriptItem, { kind: "tool" }>["partial"]> } : item) });
				break;
			case "tool_execution_end": {
				const preview = previewToolResult(event.result);
				const details = (event.result as { details?: { exitCode?: number | null; timedOut?: boolean } })?.details;
				const failed = event.isError || details?.timedOut || (typeof details?.exitCode === "number" && details.exitCode !== 0);
				this.write(`[${event.toolName}] ${event.isError ? "error" : "ok"}${preview ? `: ${preview}` : ""}`, undefined, "info", true);
				this.update({ phase: "thinking", activeItems: this.snapshot.activeItems.map(item => item.kind === "tool" && item.callId === event.toolCallId
					? { ...item, status: failed ? "error" : "success", result: event.result as NonNullable<Extract<TranscriptItem, { kind: "tool" }>["result"]>, endedAt: Date.now() } : item) });
				break;
			}
			case "compaction_start": this.flushLive(); this.update({ phase: "compacting" }); break;
			case "compaction_end":
				this.update({ phase: "thinking", activeItems: [...this.snapshot.activeItems, { id: this.nextId++, kind: "compact", summary: event.summary,
					before: event.tokensBefore, after: event.tokensAfter }], display: this.readDisplay() });
				this.write("上下文已压缩。", undefined, "info", true); break;
			case "compaction_error": break;
			case "turn_end": this.flushLive(); break;
			case "agent_end": {
				this.flushLive();
				break;
			}
			case "prompt_end": {
				this.promptResultReceived = true;
				this.flushLive();
				const result = event.result;
				this.update({ error: result.status === "success" ? undefined : result.message });
				if (result.status === "error") this.write(result.message, undefined, "error");
				if (result.status === "aborted" && !this.interrupted) this.write(result.message, undefined, "warning");
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
