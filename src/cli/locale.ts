import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
export type UiLanguage = "zh" | "en";

// Source phrases are keys, keeping protocol/model/user content outside the UI dictionary.
const english: Record<string, string> = {
	"选择语言": "Interface language", "切换 CLI 界面语言，不改变对话内容。": "Choose the CLI language. Conversation content stays as written.",
	"查看命令和快捷键": "Commands and shortcuts", "开始新会话": "Start a new session", "恢复已有会话": "Resume a session",
	"打开模型选择": "Choose a model", "打开模型思考开关": "Toggle model thinking", "打开思考档位选择": "Choose thinking effort",
	"打开思考文字展示开关": "Toggle thinking display", "查看或调整上下文窗口": "View or set the context window", "压缩上下文": "Compact context",
	"管理配置文件／新增／修改": "Choose, add or edit a configuration", "重新加载模型配置": "Reload model configuration", "切换界面语言": "Switch interface language",
	"选择模型": "Select model", "来自当前配置；确认后用于本次会话。": "Models from the current configuration. Confirm to use for this session.",
	"思考等级 Effort": "Thinking effort", "从快到强：low → medium → high → xhigh → max": "Faster to stronger: low → medium → high → xhigh → max",
	"思考文字展示": "Thinking display", "模型思考开关": "Model thinking", "模型思考": "Model thinking",
	"仅控制思考文字的默认展开；Ctrl+O 仍可展开查看。": "Controls default visibility only. Ctrl+O can still expand thinking.",
	"恢复会话": "Resume session", "↑↓ 选择会话，Enter 恢复；Esc 取消。": "Use arrows to select a session, Enter to resume, Esc to cancel.",
	"选择要修改的配置文件": "Choose a configuration to edit", "配置文件": "Configuration files",
	"选择文件后编辑；多模型文件可继续选择模型。": "Choose a file to manage its models.",
	"选择已有文件即可使用；新增与修改位于同级菜单。": "Select a file to use it, or choose Add / Edit below.",
	"当前使用": "In use", "可用配置": "Available", "配置无效，请先修正": "Invalid configuration",
	"＋ 新增配置文件": "+ Add configuration", "✎ 修改配置文件": "Edit configuration", "＋ 新增模型": "+ Add model",
	"选择要修改的模型": "Manage models", "管理模型": "Manage models", "新增模型": "Add model",
	"选择模型编辑字段，或新增模型到此文件。": "Edit a model or add another model to this file.",
	"修改配置文件": "Edit configuration", "新增配置文件": "Add configuration",
	"选择字段后 Enter 编辑；完成后保存并使用。": "Select a field and press Enter to edit. Save when ready.",
	"配置文件名（改名将另存为）": "File name (rename to save a copy)", "配置文件名": "Configuration file name", "例如 main.json": "e.g. main.json",
	"API URL": "API URL", "API Key": "API Key", "已配置；留空保留": "Configured; leave empty to keep", "填写密钥": "Enter API key",
	"模型 ID": "Model ID", "模型显示名称": "Model display name", "留空使用模型 ID": "Leave empty to use model ID",
	"接口协议": "API protocol", "服务商适配": "Provider adapter", "默认": "Default", "上下文窗口（tokens）": "Context window (tokens)",
	"最大输出（tokens）": "Max output (tokens)", "可留空": "Optional", "未填写": "Not set", "未配置": "Not configured",
	"保存并使用此配置": "Save and use configuration", "暂无可选项": "No options available",
	"Enter 编辑 · Ctrl+S 保存 · Esc 返回": "Enter edit · Ctrl+S save · Esc back", "Enter 确认 · Esc 返回": "Enter confirm · Esc back",
	"选择": "select", "确认": "confirm", "返回": "back", "切换": "switch", "补全": "complete", "补入": "insert", "收起": "collapse", "展开": "expand",
	"输入 / 查看命令": "Type / for commands", "输入会话序号，空行取消": "Session number; empty to cancel", "序号>": "#>",
	"正在查找文件…": "Finding files…", "无匹配文件": "No matching files", "无匹配命令": "No matching commands", "工作区文件": "Workspace file",
	"回复": "Reply", "思考中": "Thinking", "生成回复中": "Responding", "工具执行中": "Running tools", "压缩上下文中": "Compacting context",
	"上下文已压缩。": "Context compacted.", "没有可压缩的旧内容。": "No earlier content to compact.",
	"上下文用量未超过窗口的 1/4，暂不压缩。": "Context is below one quarter of the window; compaction skipped.",
	"已开始新会话。": "Started a new session.", "没有可恢复的会话。": "No sessions available to resume.",
	"已取消恢复会话。": "Session resume cancelled.", "请输入列表中的会话序号，或空行取消。": "Enter a listed session number, or leave empty to cancel.",
	"该会话已不可用，请重新选择。": "This session is no longer available. Choose again.", "该会话已不可用，请返回后重新打开。": "This session is no longer available. Go back and reopen the list.",
	"恢复失败，请重新选择。": "Could not resume. Choose again.", "已中断。可以修改要求后继续。": "Interrupted. Edit your request and continue.", "已中断。": "Interrupted.",
	"配置已保存并生效，会话已保留。": "Configuration saved and applied. Session preserved.",
	"当前入口未提供配置管理。": "Configuration management is unavailable in this entry point.", "当前入口未提供模型配置。": "Model configuration is unavailable in this entry point.",
	"当前入口不支持设置思考等级。": "Thinking effort is unavailable in this entry point.", "当前入口不支持设置模型思考。": "Thinking controls are unavailable in this entry point.",
	"当前入口未提供思考设置。": "Thinking controls are unavailable in this entry point.", "当前会话未使用 BYOK 配置入口。": "This session has no BYOK configuration manager.",
	"配置文件已被其他程序修改，请返回后重新打开。": "This file changed externally. Go back and reopen it.",
	"同名配置已存在，请更换文件名或从修改入口打开。": "A file with this name exists. Choose another name or use Edit.",
	"请填写有效的配置文件名，无需输入路径。": "Enter a valid configuration file name, without a path.", "请填写模型 ID。": "Enter a model ID.", "请填写 API Key。": "Enter an API key.",
	"允许本次执行": "Allow once", "本会话允许所有文件编辑": "Allow file edits for this session", "本会话记住这条命令": "Remember this command for this session",
	"拒绝，并输入修改建议": "Deny and give feedback", "输入修改建议，Enter 拒绝并发送；Esc 返回。": "Enter feedback, Enter to deny and send, Esc to go back.",
	"用户拒绝执行此工具。": "The user denied this tool.", "模型未配置": "No model configured", "模型未就绪": "Model unavailable", "新会话": "New session",
	"语言偏好保存失败。": "Could not save the language preference.", "语言已切换。": "Interface language changed.",
	"思考耗时": "Thought for", "会话已压缩": "Conversation compacted", "无匹配项": "No matches",
	"本会话允许这条命令": "Allow this command for this session", "告诉 Anti-trace 如何修改：": "Tell Anti-trace what to change:",
	"Enter 拒绝并发送建议 · Esc 返回": "Enter deny and send feedback · Esc back", "Enter 确认 · Esc 拒绝 · Shift+Tab 切换模式": "Enter confirm · Esc deny · Shift+Tab change mode",
	"/config 查看配置 · /reload 重载 · /model 切换模型": "/config settings · /reload reload · /model select model",
	"预览不可用：": "Preview unavailable: ", "替换内容与当前文件不唯一匹配。": "The replacement does not uniquely match the file.", "替换区域重叠。": "Replacement ranges overlap.",
	"BYOK 配置路径不能为空。": "The BYOK configuration path cannot be empty.",
	"尚无可用模型配置，请先加载有效的模型配置后重试；会话管理仍可使用。": "No usable model configuration. Load a valid configuration and retry; session management remains available.",
	"当前模型缺少凭据，请配置 apiKey 或 apiKeyEnv 后重试。": "The current model has no credentials. Configure apiKey or apiKeyEnv and retry.",
	"当前入口没有可用的模型目录。": "No model catalog is available in this entry point.",
	"暂无已加载的模型，请先加载有效配置；/config 查看详情。": "No models loaded. Use /config to load a valid configuration.",
	"请先用 /config 加载该会话对应的配置文件。": "Use /config to load this session's configuration first.",
	"请求模型不属于当前连接目录，不能向其他接口发送该连接的凭据。": "The requested model is outside the connection catalog; credentials cannot be sent to another endpoint.",
	"切换接口后不能继续使用原连接的静态凭据。": "The original connection's credentials cannot be reused after changing endpoints.",
	"思考档位必须是 low / medium / high / xhigh / max，开关必须是布尔值或默认。": "Effort must be low/medium/high/xhigh/max; thinking must be on/off or default.",
	"档位：low / medium / high / xhigh / max；关闭或使用服务端默认时仍保存所选档位。": "Levels: low / medium / high / xhigh / max. The chosen level is retained when thinking is off or uses server defaults.",
	"用法：/model <模型键>（对应配置文件 models 中的键）": "Usage: /model <model-key> (a key in the configuration's models catalog)",
	"当前接口没有思考控制规则；请在 adapter.thinking 中明确配置，或省略 enabled 使用服务端默认。": "This API has no thinking rules. Configure adapter.thinking or leave enabled unset for server defaults.",
	"当前接口没有思考控制规则；请配置 adapter.thinking，或省略 enabled 使用服务端默认。": "This API has no thinking rules. Configure adapter.thinking or leave enabled unset for server defaults.",
	"当前模型始终思考，无法真实关闭。": "This model always thinks and cannot disable thinking.", "当前模型不支持开启思考。": "This model does not support thinking.",
	"当前模型无法关闭思考。": "This model cannot disable thinking.", "当前模型没有真实关闭思考的编码。": "No encoding is configured to disable thinking for this model.",
	"无效的思考偏好。": "Invalid thinking preferences.", "预算思考需要明确设置 maxOutputTokens 或请求 maxTokens。": "Budgeted thinking requires maxOutputTokens or request maxTokens.",
	"输出上限无法同时容纳最低思考预算与回答预留空间。": "The output limit cannot fit both the minimum thinking budget and the answer reserve.",
	"当前协议与思考规则不匹配。": "The protocol and thinking rules do not match.", "Chat 不支持 Anthropic 思考编码。": "Chat does not support Anthropic thinking encoding.",
	"thinking.levels 只能包含开启档位；关闭值应放入 off。": "thinking.levels may contain enabled levels only; put the disabled value in off.",
	"effort 的 off 不能与开启档位或 toggle 冲突。": "effort.off cannot conflict with enabled levels or toggle.",
	"canDisable: false 不能同时指定 off 编码。": "canDisable: false cannot specify an off encoding.",
	"thinking.budgets 必须有五个严格递增且位于 minBudget/maxBudget 范围内的值。": "thinking.budgets requires five strictly increasing values within minBudget/maxBudget.",
	"交互输入需要 TTY 输出；请在终端运行，或通过管道提供完整输入。": "Interactive input requires TTY output. Run in a terminal or pipe a complete prompt.",
	"滚轮 / PgUp/PgDn 回看 · Ctrl+End 回到最新 · Shift+拖动选择文字": "Wheel / PgUp/PgDn review · Ctrl+End latest · Shift+drag select text",
};
const patterns: Array<[RegExp, (...args: string[]) => string]> = [
	[/^… 还有 (\d+) 条$/, n => `… ${n} more`], [/^… 上方 (\d+) 条 · 下方 (\d+) 条$/, (a,b) => `… ${a} above · ${b} below`],
	[/^已切换到 (.+)。$/, name => `Switched to ${name}.`], [/^思考等级已设为 (.+)。$/, level => `Thinking effort set to ${level}.`],
	[/^已恢复会话：(.+)$/, name => `Resumed session: ${name}`], [/^(.+)必须为正整数。$/, label => `${translate(label, "en")} must be a positive integer.`],
	[/^控制模型是否启用思考；当前(.+)，保留 effort (.+)。$/, (state,effort) => `Controls model thinking; currently ${translate(state,"en")}. Keeps effort ${effort}.`],
	[/^(思考文字展示|模型思考)已(开启|关闭)。$/, (name,state) => `${translate(name,"en")}: ${translate(state,"en")}.`],
	[/^⚠ 上下文已用 (\d+)% · (.+)$/, (used, detail) => `⚠ Context ${used}% used · ${detail === "接近容量上限" ? "nearing limit" : "watch context usage"}`],
	[/^无法预览：(.+)$/, detail => `Preview unavailable: ${translate(detail,"en")}`],
	[/^读取 (\d+) 行$/, n => `Read ${n} lines`], [/^写入 (\d+) 行$/, n => `Wrote ${n} lines`], [/^读取 (\d+) 个文件$/, n => `Read ${n} files`],
	[/^缺少 BYOK 配置 (.+)。请复制 byok\.example\.json 到该位置并填写模型，或用 CLI_AGENT_CONFIG 指定文件。$/, path => `Missing BYOK configuration ${path}. Use /config to create a configuration or set CLI_AGENT_CONFIG.`],
	[/^无法读取 BYOK 配置 (.+)（(.+)）。$/, (path,code) => `Cannot read BYOK configuration ${path} (${code}).`],
	[/^BYOK 配置 (.+) 不是有效的 JSON。$/, path => `BYOK configuration ${path} is not valid JSON.`],
	[/^BYOK 配置 (.+) 字段无效：(.+)（(.+)）。$/, (path,field,rule) => `Invalid BYOK configuration ${path}: ${field} (${rule}).`],
	[/^连接 (.+) 的 preset 未知。可选：(.+)$/, (key,choices) => `Connection ${key} has an unknown preset. Available: ${choices}.`],
	[/^连接 (.+) 需要 api 和 baseUrl，或明确选择连接 preset。$/, key => `Connection ${key} requires api and baseUrl, or a preset.`],
	[/^连接 (.+) 必须且只能设置 apiKey 或 apiKeyEnv 之一。$/, key => `Connection ${key} must set exactly one of apiKey or apiKeyEnv.`],
	[/^模型 (.+) 引用了不存在的连接 (.+)。$/, (model,key) => `Model ${model} references unknown connection ${key}.`],
	[/^模型 (.+) 的 maxOutputTokens 不能超过 contextWindow。$/, model => `Model ${model}: maxOutputTokens cannot exceed contextWindow.`],
	[/^模型 (.+) 的 thinking 能力与 adapter 规则冲突。$/, model => `Model ${model}: thinking capability conflicts with adapter rules.`],
	[/^未找到 BYOK 模型 (.+)。$/, model => `BYOK model ${model} was not found.`], [/^当前配置已没有模型 (.+)。$/, model => `Model ${model} is no longer in the configuration.`],
	[/^currentModel 引用了不存在的模型 (.+)。$/, model => `currentModel references unknown model ${model}.`],
	[/^模型 (.+) 缺少凭据(.*)。$/, (model,detail) => `Model ${model} has no credentials${detail.replace("：请设置环境变量 ", "; set environment variable ")}.`],
	[/^BYOK (.+) 必须是绝对 HTTP\(S\) URL。$/, field => `BYOK ${field} must be an absolute HTTP(S) URL.`],
	[/^BYOK (.+) 必须是 HTTP\(S\) URL，且不能包含凭据、查询参数或片段。$/, field => `BYOK ${field} must be an HTTP(S) URL without credentials, query parameters or fragments.`],
	[/^BYOK (.+) 是完整推理地址；请将它填入 endpoint，并用 baseUrl 保存基础地址。$/, field => `BYOK ${field} is a complete inference endpoint. Set endpoint and use baseUrl for the API root.`],
];
const fragments: Record<string, string> = {
	"由服务端默认决定": "server default", "服务端默认": "server default", "开启": "on", "关闭": "off", "上下文窗口": "Context window", "最大输出": "Max output",
	"错误：": "Error: ", "用法：": "Usage: ", "粘贴失败：": "Paste failed: ", "配置错误：": "Configuration error: ", "BYOK 配置：": "BYOK configuration: ",
	"已加载 BYOK 配置 ": "Loaded BYOK configuration ", "，当前模型：": ", current model: ", "当前仍生效：": "Still active: ", "；会话已保留。": "; session preserved.",
	"模型键：": "Model keys: ", "已加载模型键：": "Loaded model keys: ", "未配置": "Not configured", "请填写": "Enter ",
	"尚无可用模型配置；聊天与压缩需要先配置模型，会话管理仍可使用。": "No usable model configuration. Configure a model for chat or compaction; session management remains available.",
	"输入 /config 管理配置，/model 选择模型，/reload 重新加载，/exit 退出。": "Use /config to manage configurations, /model to select a model, /reload to reload, /exit to quit.",
	"选择": "select", "确认": "confirm", "收起": "collapse", "展开": "expand", "返回": "back", "补全": "complete", "补入": "insert", "取消": "cancel", "退出": "exit",
	"提交": "submit", "换行": "new line", "撤销": "undo", "重做": "redo", "中断/清空": "interrupt/clear", "中断": "interrupt", "历史": "history",
	"输入 / 打开命令菜单": "Type / for commands", "切换权限模式": "cycle permission mode", "搜索工作区文件": "search workspace files", "审批时": "approval:",
	"正整数": "positive integer", "路径": "path", "模型键": "model key", "上下文已压缩": "Context compacted", "压缩前": "before", "压缩后": "after",
	"模型：": "Model: ", "思考：": "Thinking: ", "档位：": "Effort: ", "（路径为空）": "(empty path)", "重载": "reload", "切换模型": "select model", "查看详情。": "details.",
	"adapter 配置无效：": "Invalid adapter configuration: ", "读取失败": "read failed", "当前模型：": "Current model: ", "；会话历史已保留。": "; session history preserved.",
};
const replacements = Object.entries({ ...english, ...fragments }).sort((a,b) => b[0].length - a[0].length);
export function translate(text: string, language: UiLanguage): string {
	if (language === "zh") return text;
	if (english[text] !== undefined) return english[text];
	if (text.includes("\n")) return text.split("\n").map(line => translate(line, language)).join("\n");
	if (text.startsWith("错误：")) return `Error: ${translate(text.slice(3), language)}`;
	for (const [pattern, format] of patterns) { const match = pattern.exec(text); if (match) return format(...match.slice(1)); }
	let result = text;
	for (const [source, target] of replacements) result = result.split(source).join(target);
	return result;
}

/** A per-REPL preference; no credentials or model settings enter this file. */
export class UiLocale {
	private language: UiLanguage = "zh";
	private readonly listeners = new Set<() => void>();
	private readonly path: string;
	constructor(cwd: string, private readonly persist = false) {
		this.path = join(cwd, ".ant-trace", "preferences.json");
		try { const value = JSON.parse(readFileSync(this.path,"utf8")); if (value.language === "en") this.language = "en"; } catch { /* First launch uses Chinese. */ }
	}
	getSnapshot = () => this.language;
	subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
	t = (text: string) => translate(text, this.language);
	setLanguage(language: UiLanguage): void {
		if (this.persist) {
			let previous = {};
			try { if (existsSync(this.path)) previous = JSON.parse(readFileSync(this.path,"utf8")); } catch { /* Replace malformed UI preferences. */ }
			const temporary = this.path + `.${randomUUID()}.tmp`;
			try { mkdirSync(dirname(this.path), { recursive: true }); writeFileSync(temporary, JSON.stringify({ ...previous, language }, null, 2), { mode: 0o600, flag: "wx" }); renameSync(temporary, this.path); }
			catch { throw new Error(this.t("语言偏好保存失败。")); }
			finally { if (existsSync(temporary)) unlinkSync(temporary); }
		}
		this.language = language; for (const listener of this.listeners) listener();
	}
}
