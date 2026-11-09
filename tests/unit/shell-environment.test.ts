import assert from "node:assert/strict";
import test from "node:test";
import { detectShellEnvironment } from "../../src/harness/shell-environment.ts";

const git = "C:\\Program Files\\Git\\bin\\bash.exe";
const ps5 = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
const ps7 = "D:\\PowerShell\\pwsh.exe";
function probe(files: Record<string, string>) {
	const calls: string[] = [];
	return { calls, isFile: (path: string) => path in files, run: (path: string) => { calls.push(path); return files[path]; } };
}

test("POSIX detection performs no Windows probes and keeps Bash", () => {
	for (const platform of ["darwin", "linux"] as const) {
		const io = probe({});
		assert.deepEqual(detectShellEnvironment(platform, { ANTI_TRACE_GIT_BASH_PATH: "bad" }, io), { platform, bash: "bash" });
		assert.deepEqual(io.calls, []);
	}
});

test("Windows prefers PowerShell 7 and finds a normal Git Bash installation", () => {
	const io = probe({ [ps5]: "5", [ps7]: "7", [git]: "GNU bash, version 5.2" });
	const result = detectShellEnvironment("win32", { Path: "D:\\PowerShell" }, io);
	assert.deepEqual(result, { platform: "win32", bash: git, powershell: { path: ps7, majorVersion: 7 } });
	assert.ok(!io.calls.includes(ps5));
});

test("explicit Bash paths win; invalid explicit paths fail with a configuration error", () => {
	const custom = "E:\\中文 空格\\Git\\bin\\bash.exe";
	assert.equal(detectShellEnvironment("win32", { ANTI_TRACE_GIT_BASH_PATH: custom }, probe({ [custom]: "GNU bash, version 5", [git]: "GNU bash, version 4" })).bash, custom);
	for (const path of ["relative\\bash.exe", "E:\\missing\\bash.exe", custom]) {
		assert.throws(() => detectShellEnvironment("win32", { ANTI_TRACE_GIT_BASH_PATH: path }, probe({ [ps5]: "5", [custom]: "not bash" })), /Invalid ANTI_TRACE_GIT_BASH_PATH/);
	}
});

test("PATH Git discovery handles cmd, bin and mingw64 layouts without probing WSL Bash", () => {
	for (const directory of ["E:\\PortableGit\\cmd", "E:\\PortableGit\\bin", "E:\\PortableGit\\mingw64\\bin"]) {
		const bash = "E:\\PortableGit\\bin\\bash.exe";
		const io = probe({ [`${directory}\\git.exe`]: "", [bash]: "GNU bash, version 5", "C:\\Windows\\System32\\bash.exe": "GNU bash, version WSL" });
		assert.equal(detectShellEnvironment("win32", { PATH: `C:\\Windows\\System32;"${directory}"` }, io).bash, bash);
		assert.ok(!io.calls.includes("C:\\Windows\\System32\\bash.exe"));
	}
});

test("Windows can operate without Git Bash and falls back from unusable pwsh to PowerShell 5.1", () => {
	const io = probe({ [ps5]: "5", [ps7]: "6" });
	assert.deepEqual(detectShellEnvironment("win32", { PATH: "D:\\PowerShell" }, io), {
		platform: "win32", bash: undefined, powershell: { path: ps5, majorVersion: 5 },
	});
	assert.throws(() => detectShellEnvironment("win32", {}, probe({})), /No supported shell found/);
});
