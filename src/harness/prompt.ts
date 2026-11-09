export interface BuildSystemPromptOptions {
	cwd: string;
	toolNames: string[];
	platform?: NodeJS.Platform;
	powerShellVersion?: number;
}

export function buildSystemPrompt(options: BuildSystemPromptOptions): string {
	return (options.platform ?? process.platform) === "win32" ? buildWindowsSystemPrompt(options) : buildPosixSystemPrompt(options);
}

function promptHeader(options: BuildSystemPromptOptions): string {
	const cwd = options.cwd.replace(/\\/g, "/");
	const toolsList =
		options.toolNames.length > 0 ? options.toolNames.map((name) => `- ${name}`).join("\n") : "(none)";

	return `You are Anti-trace, a CLI coding assistant.

Working directory: ${cwd}

Available tools:
${toolsList}`;
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
