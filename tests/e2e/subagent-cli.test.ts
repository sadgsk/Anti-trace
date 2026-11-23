import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { McpConfigStore } from "../../src/config/mcp.ts";
import { listSessions, loadSession } from "../../src/harness/session.ts";
import { getAppPaths } from "../../src/storage/app-paths.ts";
import { deferred, tempWorkspace, waitFor } from "../support/fixtures.ts";
import { chatResponse, createHttpFixture } from "../support/http-server.ts";
import { httpMcpServer } from "../support/mcp.ts";

function launch(cwd: string, appHome: string, tty: boolean) {
	const args = ["--import", new URL("../../node_modules/tsx/dist/loader.mjs", import.meta.url).href,
		"--import", new URL("../support/setup.ts", import.meta.url).href];
	if (tty) {
		// Supply TTY capabilities on the child's real pipes, keeping the actual CLI and input parser.
		const shim = "Object.assign(process.stdin,{isTTY:true,setRawMode(){}});Object.assign(process.stdout,{isTTY:true,columns:120,rows:32});";
		args.push("--import", "data:text/javascript," + encodeURIComponent(shim));
	}
	args.push(fileURLToPath(new URL("../../src/cli/bin.ts", import.meta.url)), "--yolo");
	const child = spawn(process.execPath, args, { cwd, env: { ...process.env, ANTI_TRACE_HOME: appHome,
		CLI_AGENT_CONFIG: join(cwd, "byok.json") }, windowsHide: true });
	let output = "";
	child.stdout.setEncoding("utf8").on("data", data => { output += data; });
	child.stderr.setEncoding("utf8").on("data", data => { output += data; });
	const closed = new Promise<number | null>((resolve, reject) => {
		child.once("error", reject);
		child.once("close", resolve);
	});
	async function stop() {
		if (child.exitCode === null && !child.signalCode) child.kill("SIGKILL");
		await closed;
	}
	return { child, closed, stop, async visible(text: string) {
		try { await waitFor(() => output.includes(text), text, 15000); }
		catch (error) { throw new Error(String(error) + "\n" + output.slice(-4000)); }
	} };
}

function tool(id: string, name: string, args: object): string {
	const call = { index: 0, id, function: { name, arguments: JSON.stringify(args) } };
	return `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [call] }, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`;
}

for (const abrupt of [false, true]) test(`standalone CLI recovers paused work after ${abrupt ? "forced termination" : "normal exit"} without replaying its external write`, { timeout: 60000 }, async t => {
	const processes: ReturnType<typeof launch>[] = [];
	const root = tempWorkspace(t, async () => { await Promise.all(processes.map(cli => cli.stop())); });
	const appHome = join(root, "app");
	const paths = getAppPaths({ cwd: root, appHome });
	const effectFile = join(root, "writes.txt");
	const effect = deferred();
	const mcp = await httpMcpServer(t, [{ name: "append", inputSchema: { type: "object" } }], () => {
		appendFileSync(effectFile, "one write\n");
		effect.resolve();
		// Keep the response in flight until the CLI disconnects.
	});
	new McpConfigStore(root, paths).save("user", "ledger", { type: "http", url: mcp.url });
	let agentId = "", reopening = false;
	const children: string[] = [];
	const http = await createHttpFixture(t, async ({ body }, response) => {
		const req = body as { tools: { function: { name: string } }[]; messages: { role: string; content: string; tool_call_id?: string }[] };
		const last = req.messages.at(-1)!;
		let reply: string;
		if (!req.tools.some(def => def.function.name === "agent_task")) {
			children.push(JSON.stringify(req.messages));
			reply = reopening ? chatResponse("RESUMED_CHILD_REPORT") : tool("effect", "mcp__ledger__append", {});
		} else if (!reopening) {
			if (last.role === "user") reply = tool("start", "agent_task", { action: "start", prompt: "Append one entry to the ledger" });
			else {
				agentId = JSON.parse(last.content).agent_id;
				await effect.promise;
				reply = abrupt ? tool("wait-at-crash", "wait_agent", { agent_id: agentId }) : chatResponse("parent finished");
			}
		} else if (last.role === "user") {
			if (abrupt) {
				const repaired = req.messages.filter(message => message.tool_call_id === "wait-at-crash");
				assert.equal(repaired.length, 1);
				assert.equal(JSON.parse(repaired[0]!.content).status, "interrupted");
			}
			reply = tool("check", "wait_agent", { agent_id: agentId });
		} else if (last.tool_call_id === "check") {
			assert.deepEqual(JSON.parse(last.content), { agent_id: agentId, status: "paused" });
			assert.equal(children.length, 1, "reopening must leave the child paused");
			reply = tool("resume", "agent_task", { action: "resume", agent_id: agentId });
		} else if (last.tool_call_id === "resume") {
			assert.equal(JSON.parse(last.content).status, "running");
			reply = tool("report", "wait_agent", { agent_id: agentId });
		} else {
			assert.deepEqual(JSON.parse(last.content), { agent_id: agentId, status: "completed", report: "RESUMED_CHILD_REPORT" });
			reply = chatResponse("REOPEN_FINISHED");
		}
		response.writeHead(200, { "content-type": "text/event-stream" }).end(reply);
	});
	writeFileSync(join(root, "byok.json"), JSON.stringify({ version: 1, currentModel: "main",
		connections: { local: { api: "openai-completions", baseUrl: http.url, apiKey: "fake-key" } },
		models: { main: { connection: "local", id: "fixture", contextWindow: 100000 } } }));
	const first = launch(root, appHome, false);
	processes.push(first);
	first.child.stdin.end("spawn the ledger task");
	await first.visible(abrupt ? "[wait_agent] running" : "parent finished");
	assert.ok(agentId);
	if (abrupt) first.child.kill("SIGKILL");
	const exitCode = await first.closed;
	if (!abrupt) assert.equal(exitCode, 0);
	assert.equal(readFileSync(effectFile, "utf8"), "one write\n");
	const [session] = listSessions(root, paths);
	assert.ok(session);
	const transcript = join(dirname(session.filePath), loadSession(session.filePath).header.id, "subagents", `agent-${agentId}.jsonl`);
	const rows = readFileSync(transcript, "utf8").trim().split("\n").map(line => JSON.parse(line));
	assert.equal(rows.filter(row => row.type === "subagent_state").at(-1).status, abrupt ? "running" : "paused");
	if (abrupt) assert.ok(!rows.some(row => row.message?.toolCallId === "effect"));
	reopening = true;
	const second = launch(root, appHome, true);
	processes.push(second);
	await second.visible("\x1b[?2004h");
	second.child.stdin.write("/resume\r");
	await second.visible("选择会话");
	second.child.stdin.write("\r");
	await second.visible("已恢复会话");
	second.child.stdin.write("check and resume the ledger task\r");
	await second.visible("REOPEN_FINISHED");
	second.child.stdin.end();
	assert.equal(await second.closed, 0);
	assert.equal(children.length, 2);
	if (abrupt) assert.match(children[1]!, /结果未知|outcome unknown/i);
	assert.equal(mcp.calls.length, 1);
	assert.equal(readFileSync(effectFile, "utf8"), "one write\n");
});

