import assert from "node:assert/strict";
import test from "node:test";
import { addStdioServer } from "../support/mcp.ts";
import { createTestHarness, messageText } from "../support/harness.ts";

test("MCP model resource tools list and read on demand, target the approved URI and do not expose prompts", async t => {
	const one = "file:///unlisted-on-server", two = "file:///different";
	const call = (id: string, name: string, args: Record<string, unknown>) => ({ id, name, arguments: args });
	const f = createTestHarness(t, [{ toolCalls: [call("list", "mcp_list_resources", { server: "repo" })] },
		{ toolCalls: [call("read", "mcp_read_resource", { server: "repo", uri: one }), call("deny", "mcp_read_resource", { server: "repo", uri: two })] },
		{ text: "read the selected resource" }]);
	t.after(() => f.harness.close());
	const records = await addStdioServer(f.harness, f.root, "repo");
	const approvals = new Map<string, string>();
	f.harness.setBeforeToolCall(async context => {
		const permission = context.permission!;
		approvals.set(context.toolCall.id, permission.actionKey);
		return context.toolCall.id === "deny" ? { block: true, reason: "denied" } : undefined;
	});
	await f.harness.prompt("Read the guide");
	assert.equal(new Set(approvals.values()).size, 3);
	const first = f.scripted.requests[0]!.context;
	assert.ok(first.tools?.some(tool => tool.name === "mcp_list_resources"));
	assert.ok(first.tools?.some(tool => tool.name === "mcp_read_resource"));
	assert.ok(first.tools?.every(tool => !tool.name.includes("prompt")));
	assert.doesNotMatch(JSON.stringify(first), /fixture:\/\/notes|resource body/);
	const results = f.agent.state.messages.filter(message => message.role === "toolResult");
	assert.deepEqual(results.map(message => [message.toolCallId, message.isError]), [["list", false], ["read", false], ["deny", true]]);
	assert.match(messageText(results[0]), /fixture:\/\/notes\/\{id\}/);
	assert.match(messageText(results[1]), /resource body/);
	assert.match(messageText(results[1]), /file:\/\/\/unlisted-on-server/);
	const calls = records();
	assert.deepEqual(calls.filter(record => record.method === "resources/read").map(record => record.params), [{ uri: one }]);
	assert.equal(calls.filter(record => record.method?.startsWith("prompts/")).length, 0);
});
