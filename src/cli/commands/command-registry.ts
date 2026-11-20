/** Shared by command routing, help output and the interactive command menu. */
export interface SlashCommandDefinition {
	readonly name: string;
	readonly description: string;
	readonly argumentHint?: string;
	readonly argumentRequired?: boolean;
	/** /resume accepts only the command itself; selection happens in the next prompt. */
	readonly exact?: boolean;
}

export const SLASH_COMMANDS = [
	{ name: "help", description: "查看命令和快捷键" },
	{ name: "new", description: "开始新会话" },
	{ name: "resume", description: "恢复已有会话", exact: true },
	{ name: "model", description: "打开模型选择", argumentHint: "[模型键]" },
	{ name: "thinking", description: "打开模型思考开关", argumentHint: "[on|off|default]" },
	{ name: "effort", description: "打开思考档位选择", argumentHint: "[low|medium|high|xhigh|max]" },
	{ name: "thinking-display", description: "打开思考文字展示开关", argumentHint: "[on|off]" },
	{ name: "context", description: "查看或调整上下文窗口", argumentHint: "[正整数]" },
	{ name: "compact", description: "压缩上下文" },
	{ name: "skill", description: "选择并使用技能", argumentHint: "[技能名 参数|--reload]" },
	{ name: "config", description: "管理配置文件／新增／修改", argumentHint: "[路径]" },
	{ name: "reload", description: "重新加载模型配置" },
	{ name: "mcp", description: "管理 MCP 服务器与能力目录", argumentHint: "[子命令]" },
	{ name: "mcp-resource", description: "读取 MCP 资源并加入草稿", argumentHint: "[服务器 URI]" },
	{ name: "mcp-prompt", description: "展开 MCP 提示模板并加入草稿", argumentHint: "[服务器 模板 JSON参数]" },
	{ name: "language", description: "切换界面语言", argumentHint: "[zh|en]" },
	{ name: "exit", description: "退出" },
] as const satisfies readonly SlashCommandDefinition[];

export type SlashCommandName = typeof SLASH_COMMANDS[number]["name"];

export function commandUsage(command: SlashCommandDefinition): string {
	return `/${command.name}${command.argumentHint ? ` ${command.argumentHint}` : ""}`;
}

/** Only MCP prompt arguments accept multiline JSON. */
export function parseSlashCommand(text: string): { command: SlashCommandDefinition; argument: string } | null {
	const match = /^\/([a-z-]+)(?:\s+(.*))?$/su.exec(text.trim());
	if (!match) return null;
	const command: SlashCommandDefinition | undefined = SLASH_COMMANDS.find(item => item.name === match[1]);
	if (!command || (command.exact && match[2] !== undefined)) return null;
	if (command.name !== "mcp-prompt" && /[\r\n]/u.test(text)) return null;
	return { command, argument: match[2] ?? "" };
}
