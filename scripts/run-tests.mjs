import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Enumerate paths in Node: shell glob expansion differs on Windows and POSIX.
const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const testsRoot = join(projectRoot, "tests");
function discover(directory) {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) return entry.name === "support" ? [] : discover(path);
		return /\.test\.(ts|tsx)$/.test(entry.name) ? [path] : [];
	});
}

const args = process.argv.slice(2);
const watch = args.includes("--watch");
const nameIndex = args.indexOf("--name");
if (nameIndex !== -1 && (!args[nameIndex + 1] || args[nameIndex + 1].startsWith("--"))) {
	throw new Error("--name requires a test name pattern");
}
const namePattern = nameIndex === -1 ? undefined : args[nameIndex + 1];
const filters = args.filter((arg, index) => arg !== "--watch" && (nameIndex === -1 || (index !== nameIndex && index !== nameIndex + 1)));
if (filters.some((filter) => filter.startsWith("--"))) throw new Error("Use path filters, --name <pattern>, or --watch");
const files = discover(testsRoot).sort().filter((file) => {
	const path = relative(testsRoot, file).replaceAll("\\", "/");
	return filters.length === 0 || filters.some((filter) => path.includes(filter.replaceAll("\\", "/").replace(/^tests\//, "")));
});
if (files.length === 0) throw new Error(`No tests matched: ${filters.join(", ")}`);

const root = mkdtempSync(join(tmpdir(), "cli-agent-tests-"));
const home = join(root, "home");
const workspace = join(root, "workspace");
for (const path of [home, workspace, join(root, "tmp"), join(home, ".config"), join(root, "cache")]) {
	mkdirSync(path, { recursive: true });
}

// Do not inherit credentials, NODE_OPTIONS, proxy settings, or application config.
const env = {};
const allowed = /^(path|systemroot|windir|comspec|pathext|processor_architecture|number_of_processors|ci|github_actions|term|colorterm|no_color|force_color)$/i;
for (const [key, value] of Object.entries(process.env)) {
	if (allowed.test(key) && value !== undefined) env[key] = value;
}
Object.assign(env, {
	HOME: home, USERPROFILE: home,
	TMPDIR: join(root, "tmp"), TMP: join(root, "tmp"), TEMP: join(root, "tmp"),
	XDG_CONFIG_HOME: join(home, ".config"), XDG_CACHE_HOME: join(root, "cache"),
	APPDATA: join(home, ".config"), LOCALAPPDATA: join(root, "cache"),
	TZ: "UTC", LANG: "C.UTF-8", LC_ALL: "C.UTF-8",
	CLI_AGENT_TEST_ROOT: root, CLI_AGENT_PROJECT_ROOT: projectRoot,
	TSX_TSCONFIG_PATH: join(projectRoot, "tsconfig.json"),
	// Ink suppresses interactive frames when CI=true. Fake TTYs emulate a user's terminal.
	CI: "false",
	GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
	GIT_TERMINAL_PROMPT: "0",
});
if (process.env.NODE_V8_COVERAGE) env.NODE_V8_COVERAGE = resolve(process.env.NODE_V8_COVERAGE);

const nodeArgs = [
	"--import", new URL("../node_modules/tsx/dist/loader.mjs", import.meta.url).href,
	"--import", pathToFileURL(join(testsRoot, "support", "setup.ts")).href,
	"--test", "--test-concurrency=1", "--test-timeout=90000", "--test-reporter=spec",
];
if (watch) nodeArgs.push("--watch");
if (namePattern) nodeArgs.push(`--test-name-pattern=${namePattern}`);
nodeArgs.push(...files);
console.log(`Running ${files.length} test files with an isolated home and loopback-only networking.`);

let child;
const onInterrupt = () => child?.kill("SIGINT");
const onTerminate = () => child?.kill("SIGTERM");
process.on("SIGINT", onInterrupt);
process.on("SIGTERM", onTerminate);
try {
	child = spawn(process.execPath, nodeArgs, { cwd: workspace, env, stdio: "inherit", windowsHide: true });
	const code = await new Promise((resolveCode, reject) => {
		child.once("error", reject);
		child.once("exit", (exitCode, signal) => resolveCode(exitCode ?? (signal ? 1 : 0)));
	});
	process.exitCode = code;
} finally {
	process.off("SIGINT", onInterrupt);
	process.off("SIGTERM", onTerminate);
	// Only delete the direct child of tmpdir created by this invocation.
	if (dirname(root) !== resolve(tmpdir()) || !root.startsWith(join(resolve(tmpdir()), "cli-agent-tests-"))) {
		throw new Error(`Refusing to remove unexpected test root: ${root}`);
	}
	rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
