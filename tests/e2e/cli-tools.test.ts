import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { tempWorkspace } from "../support/fixtures.ts";
import { chatResponse, createHttpFixture } from "../support/http-server.ts";
import { writeSkill } from "../support/skills.ts";
import { cli, configureCli } from "../support/cli-process.ts";

test("standalone CLI lists skills without a model and manually loads a skill with parameters", async t => {
	const root = tempWorkspace(t); writeSkill(root, "review", "E2E_SKILL_SCOPE=$ARGUMENTS");
	const listing = await cli(t, root, "/skill");
	assert.equal(listing.code, 0); assert.match(listing.stdout, /review/);
	const http = await createHttpFixture(t, (_request, response) => { response.writeHead(200, { "content-type": "text/event-stream" }).end(chatResponse("SKILL_MANUAL_OK")); });
	configureCli(root, http.url);
	const result = await cli(t, root, "/skill review current diff");
	assert.equal(result.code, 0, result.stderr); assert.match(result.stdout, /SKILL_MANUAL_OK/);
	assert.match(JSON.stringify(http.requests[0]!.body), /E2E_SKILL_SCOPE=current diff/);
});

test("standalone CLI exposes the unified tool and handles an actual model skill call", async t => {
	const root = tempWorkspace(t); writeSkill(root, "review", "E2E_MODEL_SKILL_INSTRUCTIONS");
	const http = await createHttpFixture(t, (_request, response, index) => {
		response.writeHead(200, { "content-type": "text/event-stream" });
		if (!index) response.end(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "load", function: { name: "skill", arguments: '{"skill":"review"}' } }] }, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`);
		else response.end(chatResponse("SKILL_MODEL_OK"));
	});
	configureCli(root, http.url);
	const result = await cli(t, root, "Review this task");
	assert.equal(result.code, 0, result.stderr); assert.match(result.stdout, /SKILL_MODEL_OK/);
	assert.equal(http.requests.length, 2);
	assert.doesNotMatch(JSON.stringify(http.requests[0]!.body), /E2E_MODEL_SKILL_INSTRUCTIONS/);
	assert.match(JSON.stringify(http.requests[1]!.body), /E2E_MODEL_SKILL_INSTRUCTIONS/);
});

test("noninteractive default policy blocks real file writes and returns a paired result", async (t) => {
	const root = tempWorkspace(t);
	const http = await createHttpFixture(t, (_request, response, index) => {
		response.writeHead(200, { "content-type": "text/event-stream" });
		if (index === 0) response.end(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "write", function: {
			name: "write", arguments: JSON.stringify({ path: "should-not-exist.txt", content: "blocked" }),
		} }] }, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`);
		else response.end(chatResponse("permission handled"));
	});
	configureCli(root, http.url);
	const result = await cli(t, root, "write a file");
	assert.equal(result.code, 0, result.stderr);
	assert.equal(existsSync(join(root, "should-not-exist.txt")), false);
	assert.equal(http.requests.length, 2);
	assert.match(JSON.stringify(http.requests[1]!.body), /非交互模式无法请求权限/);
});

test("Windows launched from CMD deletes through PowerShell and completes the model round-trip", { skip: process.platform !== "win32" }, async t => {
	const root = tempWorkspace(t), file = join(root, "删除 [a] ' 空格.txt"); writeFileSync(file, "delete me");
	const http = await createHttpFixture(t, (_request, response, index) => {
		response.writeHead(200, { "content-type": "text/event-stream" });
		if (index === 0) response.end(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "delete", function: {
			name: "powershell", arguments: JSON.stringify({ command: `Remove-Item -LiteralPath '${file.replaceAll("'", "''")}'; Write-Output 'DELETE_OK'`, timeout: 10 }),
		} }] }, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`);
		else response.end(chatResponse("WINDOWS_DELETE_FINISHED"));
	});
	configureCli(root, http.url);
	const result = await cli(t, root, "delete the temporary file", {}, true);
	assert.equal(result.code, 0, result.stdout + result.stderr); assert.equal(existsSync(file), false);
	assert.match(result.stdout, /WINDOWS_DELETE_FINISHED/); assert.equal(http.requests.length, 2);
	const request = JSON.stringify(http.requests[0]!.body), followup = JSON.stringify(http.requests[1]!.body);
	assert.match(request, /You are ResidualX/); assert.match(request, /Platform: Windows/); assert.match(request, /Prefer powershell/);
	assert.match(followup, /DELETE_OK/); assert.match(followup, /powershell_result/);
});
