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

Use bash to list files, read files, and run commands.

Be concise.`;
}
