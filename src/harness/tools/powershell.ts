import { getShellEnvironment } from "../shell-environment.ts";
import { createShellTool } from "./shell.ts";
import type { AppPaths } from "../../storage/app-paths.ts";

export function createPowerShellTool(cwd: string, config = getShellEnvironment().powershell, paths?: AppPaths) {
	if (!config) throw new Error("PowerShell is not available on this system.");
	return createShellTool(cwd, {
		name: "powershell", path: config.path,
		description: `Run PowerShell ${config.majorVersion} commands in the working directory. Prefer this tool for Windows commands. ` +
			(config.majorVersion < 7 ? "Use PowerShell 5.1 syntax: && and || are unavailable; use ; if ($?) { ... } for conditional chaining. " : "PowerShell 7 syntax, including && and ||, is supported. ") +
			"Use read, edit and write for file operations. Use Remove-Item -LiteralPath for deletion. Commands run without profiles or interactive input.",
		args: powerShellArgs,
	}, paths);
}

/** EncodedCommand preserves Unicode and quotes across Windows' native argv parsing. */
export function powerShellArgs(command: string): string[] {
	// Set this before New-Object auto-loads modules: Windows PowerShell 5.1
	// otherwise serializes initialization progress as CLIXML on stderr.
	const script = `$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding
$LASTEXITCODE = $null
try {
${command}
$commandSucceeded = $?
if ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE }
if (-not $commandSucceeded) { exit 1 }
exit 0
} catch { [Console]::Error.WriteLine($_.ToString()); exit 1 }
`;
	return ["-NoLogo", "-NoProfile", "-NonInteractive", "-InputFormat", "Text", "-OutputFormat", "Text", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")];
}
