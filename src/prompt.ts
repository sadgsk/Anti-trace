export interface BuildSystemPromptOptions {
	cwd: string;
	toolNames: string[];
}

export function buildSystemPrompt(options: BuildSystemPromptOptions): string {
	const cwd = options.cwd.replace(/\\/g, "/");
	const toolsList =
		options.toolNames.length > 0 ? options.toolNames.map((name) => `- ${name}`).join("\n") : "(none)";

	return `You are a CLI coding assistant.

Working directory: ${cwd}

Available tools:
${toolsList}

Use read to examine files. Use edit for unique text replacements in an existing file. Use write to create or overwrite a whole file. Use bash to list files and run commands.

Be concise.`;
}
