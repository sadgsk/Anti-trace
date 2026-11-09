import type { AgentTool } from "../../types.ts";
import { getShellEnvironment } from "../shell-environment.ts";
import { createShellTool, shellSchema, type ShellToolDetails } from "./shell.ts";

export { shellSchema as bashSchema } from "./shell.ts";
export type { ShellToolInput as BashToolInput, ShellToolDetails as BashToolDetails } from "./shell.ts";

export function createBashTool(cwd: string, shellPath = getShellEnvironment().bash): AgentTool<typeof shellSchema, ShellToolDetails> {
	if (!shellPath) throw new Error("Git Bash is not available. Install Git for Windows or set ANTI_TRACE_GIT_BASH_PATH to its bin\\bash.exe.");
	return createShellTool(cwd, {
		name: "bash", path: shellPath, args: command => ["-lc", command],
		description: "Run a Bash command in the working directory. Use Bash syntax." + (process.platform === "win32"
			? " This runs Git Bash. Prefer powershell for general Windows commands; use bash for Bash scripts and POSIX-specific syntax." : ""),
	});
}
