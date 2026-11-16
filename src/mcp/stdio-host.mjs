// Each SDK connection (including its disposable version probe) owns one host.
// POSIX uses a process group; on Windows the outer launcher owns a Job Object.
import spawn from "cross-spawn";
const payload = process.platform === "win32" && process.argv[2] === "--env-payload";
const [command, ...args] = payload ? JSON.parse(process.env._ANTI_TRACE_MCP_ARGV) : process.argv.slice(2);
if (payload) for (const key of ["_ANTI_TRACE_MCP_NODE", "_ANTI_TRACE_MCP_HOST", "_ANTI_TRACE_MCP_ARGV"]) delete process.env[key];
const child = spawn(command, args, { shell: false, windowsHide: true, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] });
let stopping = false;
function stop() {
	if (stopping) return;
	stopping = true;
	process.stdin.unpipe(child.stdin);
	child.stdin.end();
	if (process.platform === "win32") {
		// The owner observes this host's exit and closes the Job, including any
		// descendants whose immediate server parent has already exited.
		process.exit(0);
	} else if (child.pid) {
		try { process.kill(-child.pid, "SIGTERM"); } catch {}
	}
	setTimeout(() => {
		if (child.pid && process.platform !== "win32") { try { process.kill(-child.pid, "SIGKILL"); } catch {} }
		else child.kill();
		process.exit(0);
	}, 650);
}
process.stdin.pipe(child.stdin);
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);
child.stdin.on("error", stop);
child.stdout.on("error", stop);
child.stderr.on("error", stop);
process.stdout.on("error", stop);
process.stderr.on("error", stop);
process.stdin.on("end", stop);
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
child.once("error", () => { process.stderr.write("MCP server process could not start.\n"); stop(); });
child.once("exit", stop);
