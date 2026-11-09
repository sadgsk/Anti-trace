import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import { win32 } from "node:path";

export interface PowerShellConfig { path: string; majorVersion: number }
export interface ShellEnvironment {
	platform: NodeJS.Platform;
	bash?: string;
	powershell?: PowerShellConfig;
}

interface ShellProbe {
	isFile(path: string): boolean;
	run(path: string, args: string[]): string | undefined;
}
const systemProbe: ShellProbe = {
	isFile(path) { try { return statSync(path).isFile(); } catch { return false; } },
	run(path, args) {
		const result = spawnSync(path, args, { encoding: "utf8", timeout: 3000, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
		return !result.error && result.status === 0 ? result.stdout.trim() : undefined;
	},
};

let startupEnvironment: ShellEnvironment | undefined;
export function getShellEnvironment(): ShellEnvironment {
	return startupEnvironment ??= detectShellEnvironment();
}

/** Detect once during harness assembly. The probe also allows Windows paths to be tested on POSIX. */
export function detectShellEnvironment(
	platform: NodeJS.Platform = process.platform,
	env: NodeJS.ProcessEnv = process.env,
	probe: ShellProbe = systemProbe,
): ShellEnvironment {
	if (platform !== "win32") return { platform, bash: "bash" };
	const value = (name: string) => Object.entries(env).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
	const directories = (value("PATH") ?? "").split(";").map(path => path.trim().replace(/^"(.*)"$/, "$1")).filter(win32.isAbsolute);
	const programFiles = value("ProgramFiles") ?? `${value("SystemDrive") ?? "C:"}\\Program Files`;
	const programFilesX86 = value("ProgramFiles(x86)") ?? `${value("SystemDrive") ?? "C:"}\\Program Files (x86)`;
	const bashCandidates = [win32.join(programFiles, "Git", "bin", "bash.exe"), win32.join(programFilesX86, "Git", "bin", "bash.exe")];
	if (value("LOCALAPPDATA")) bashCandidates.push(win32.join(value("LOCALAPPDATA")!, "Programs", "Git", "bin", "bash.exe"));
	// Find bash beside Git, not via `where bash`: System32's bash.exe can launch WSL.
	for (const directory of directories) {
		if (!probe.isFile(win32.join(directory, "git.exe"))) continue;
		let root = win32.dirname(directory);
		if (/^mingw(?:32|64)$/i.test(win32.basename(root))) root = win32.dirname(root);
		bashCandidates.push(win32.join(root, "bin", "bash.exe"));
	}
	const validBash = (path: string) => probe.isFile(path) && probe.run(path, ["--version"])?.startsWith("GNU bash,");
	const explicitBash = value("ANTI_TRACE_GIT_BASH_PATH");
	if (explicitBash && (!win32.isAbsolute(explicitBash) || !validBash(explicitBash))) {
		throw new Error(`Invalid ANTI_TRACE_GIT_BASH_PATH: ${explicitBash}. Set it to Git for Windows' bin\\bash.exe.`);
	}
	const bash = explicitBash ?? [...new Set(bashCandidates)].find(validBash);
	let powershell: PowerShellConfig | undefined;
	const candidates = [
		...directories.map(directory => win32.join(directory, "pwsh.exe")),
		win32.join(programFiles, "PowerShell", "7", "pwsh.exe"),
		...directories.map(directory => win32.join(directory, "powershell.exe")),
		win32.join(value("SystemRoot") ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
	];
	for (const path of new Set(candidates)) {
		if (!probe.isFile(path)) continue;
		const version = probe.run(path, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSVersion.Major"]);
		const majorVersion = Number(version);
		if (Number.isInteger(majorVersion) && (majorVersion === 5 || majorVersion >= 7)) { powershell = { path, majorVersion }; break; }
	}
	if (!bash && !powershell) throw new Error("No supported shell found. Install PowerShell or Git for Windows; set ANTI_TRACE_GIT_BASH_PATH for a custom Git Bash installation.");
	return { platform, bash, powershell };
}
