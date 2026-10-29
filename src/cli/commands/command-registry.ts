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
	{ name: "model", description: "选择本次运行的模型", argumentHint: "<模型键>", argumentRequired: true },
	{ name: "thinking", description: "查看或设置思考开关", argumentHint: "[on|off|default]" },
	{ name: "effort", description: "查看或设置思考档位", argumentHint: "[low|medium|high|xhigh|max]" },
	{ name: "thinking-display", description: "查看或设置思考文字显示", argumentHint: "[on|off]" },
	{ name: "context", description: "查看或调整上下文窗口", argumentHint: "[正整数]" },
	{ name: "compact", description: "压缩上下文" },
	{ name: "config", description: "查看或更换 BYOK 配置", argumentHint: "[路径]" },
	{ name: "reload", description: "重新加载模型配置" },
	{ name: "exit", description: "退出" },
] as const satisfies readonly SlashCommandDefinition[];

export type SlashCommandName = typeof SLASH_COMMANDS[number]["name"];

export function commandUsage(command: SlashCommandDefinition): string {
	return `/${command.name}${command.argumentHint ? ` ${command.argumentHint}` : ""}`;
}

/** Keep multiline prompts and unknown slash-prefixed text on the ordinary chat path. */
export function parseSlashCommand(text: string): { command: SlashCommandDefinition; argument: string } | null {
	if (/[\r\n]/u.test(text)) return null;
	const match = /^\/([a-z-]+)(?:\s+(.*))?$/u.exec(text.trim());
	if (!match) return null;
	const command: SlashCommandDefinition | undefined = SLASH_COMMANDS.find(item => item.name === match[1]);
	if (!command || (command.exact && match[2] !== undefined)) return null;
	return { command, argument: match[2] ?? "" };
}
