import type { SkillDirectory } from "./skills/types.ts";

export interface BuildSystemPromptOptions {
	cwd: string;
	toolNames: string[];
	skillDirectories?: readonly SkillDirectory[];
	platform?: NodeJS.Platform;
	powerShellVersion?: number;
}

export function buildSystemPrompt(options: BuildSystemPromptOptions): string {
	return (options.platform ?? process.platform) === "win32" ? buildWindowsSystemPrompt(options) : buildPosixSystemPrompt(options);
}

function skillStoragePrompt(directories: readonly SkillDirectory[] = []): string {
	if (!directories.length) return "";
	const locations = directories.map(directory => `- ${directory.source === "project" ? "Project skills (default for creation)" : "User skills (shared across projects)"}: ${JSON.stringify(directory.path.replace(/\\/g, "/"))}`).join("\n");
	return `\n\nSkill storage:\n${locations}
Use these runtime-resolved directories to read, create and edit skills. Create project skills by default; use the user directory when the user requests a personal or cross-project skill.
Store each skill at <skills-directory>/<name>/SKILL.md. Start SKILL.md with YAML frontmatter between --- lines containing name and description, followed by nonempty Markdown instructions. The name must match the directory and use 1–64 lowercase letters, numbers or single hyphens. Use the existing file or shell tools to create skills. Valid skills are discovered before the next model request.`;
}

function promptHeader(options: BuildSystemPromptOptions): string {
	const cwd = options.cwd.replace(/\\/g, "/");
	const toolsList =
		options.toolNames.length > 0 ? options.toolNames.map((name) => `- ${name}`).join("\n") : "(none)";

	return `You are Anti-trace, a CLI coding assistant.

Working directory: ${cwd}

Available tools:
${toolsList}${options.toolNames.includes("skill") ? `

The conversation includes an available-skills catalog. When a task matches a skill's description, call skill with its name and arguments before performing the task. Follow loaded skill instructions using the existing tools. Only the most recent catalog defines which skills are currently available. A program-generated skill instruction is context, not a new user request.` : ""}${skillStoragePrompt(options.skillDirectories)}`;
}

function buildPosixSystemPrompt(options: BuildSystemPromptOptions): string {
	return `${promptHeader(options)}

Use read to examine files. Use edit for unique text replacements in an existing file. Use write to create or overwrite a whole file. Use bash to list files and run commands.

Be concise.`;
}

function buildWindowsSystemPrompt(options: BuildSystemPromptOptions): string {
	const shellRules: string[] = [];
	if (options.toolNames.includes("powershell")) {
		shellRules.push("Prefer powershell to list files and run general Windows commands. Use PowerShell syntax, $env:NAME for environment variables, $null for null redirection, and Remove-Item -LiteralPath for deletion.");
		shellRules.push((options.powerShellVersion ?? 5) >= 7
			? "PowerShell 7 or later is available; && and || are supported."
			: "PowerShell 5.1: && and || are unavailable. Use A; if ($?) { B } for conditional chaining.");
	}
	if (options.toolNames.includes("bash")) shellRules.push("Use bash for Bash scripts or POSIX-specific commands. It runs Git Bash, not CMD; use Bash syntax and forward-slash paths.");
	return `${promptHeader(options)}

Platform: Windows.

Use read to examine files. Use edit for unique text replacements in an existing file. Use write to create or overwrite a whole file.
${shellRules.join("\n")}

Be concise.`;
}
