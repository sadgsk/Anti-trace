import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { Harness } from "../../src/harness/harness.ts";
import { streamModel } from "../../src/llm/adapter.ts";
import { createHttpFixture } from "../support/http-server.ts";
import { tempWorkspace } from "../support/fixtures.ts";
import { testModel, messageText } from "../support/harness.ts";
import { echoDefinition, httpMcpServer } from "../support/mcp.ts";
import { nativeResponse } from "../support/native-response.ts";

type Wire = Record<string, any>;

for (const api of ["openai-completions", "openai-responses", "anthropic-messages"] as const) {
	test(`MCP ${api} wire exposes the remote schema and returns paired content for success and business failure`, async t => {
		const root = tempWorkspace(t);
		const image = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j9WQAAAAASUVORK5CYII=";
		const server = await httpMcpServer(t, [echoDefinition], req => req.arguments.text === "bad"
			? { isError: true, content: [{ type: "text", text: "MCP_BUSINESS_FAILURE" }] }
			: { content: [{ type: "image", mimeType: "image/png", data: image }],
				structuredContent: { output: "MCP_STRUCTURED_RESULT" } });
		const name = "mcp__wire__echo";
		const calls = [{ id: "call_one", name, args: { text: "ok" } }, { id: "call_two", name, args: { text: "bad" } }];
		const provider = await createHttpFixture(t, (_request, response, index) => {
			response.writeHead(200, { "Content-Type": "text/event-stream" }).end(nativeResponse(api, index ? [] : calls, "finished"));
		});
		const harness = new Harness({ cwd: root, appHome: join(root, "app"), model: { ...testModel, api, baseUrl: provider.url },
			apiKey: "local-key", streamFn: streamModel });
		t.after(() => harness.close());
		harness.setBeforeToolCall(async () => undefined);
		await harness.mcp.save("user", "wire", { type: "http", url: server.url, headers: { "x-service-secret": "TEST_SECRET" } });
		await harness.prompt("Run both checks");
		assert.equal(messageText(harness.agent.state.messages.at(-1)), "finished");
		assert.equal(provider.requests.length, 2);
		const [first, second] = provider.requests.map(req => req.body as Wire);
		const exposed = first!.tools.map((tool: Wire) => tool.function ?? tool).filter((tool: Wire) => tool.name === name);
		assert.equal(exposed.length, 1);
		assert.deepEqual(exposed[0].parameters ?? exposed[0].input_schema, echoDefinition.inputSchema);
		assert.deepEqual(server.calls.map(call => [call.name, call.arguments.text]), [["echo", "ok"], ["echo", "bad"]]);
		const payload = JSON.stringify(second);
		assert.match(payload, /MCP_STRUCTURED_RESULT/);
		assert.match(payload, /MCP_BUSINESS_FAILURE/);
		assert.ok(payload.includes(image), "the actual image bytes are delivered to the model");
		assert.doesNotMatch(JSON.stringify(provider.requests), /TEST_SECRET/);
		if (api === "openai-completions") {
			assert.deepEqual(second!.messages.filter((m: Wire) => m.role === "tool").map((m: Wire) => m.tool_call_id), ["call_one", "call_two"]);
		} else if (api === "openai-responses") {
			assert.deepEqual(second!.input.filter((m: Wire) => m.type === "function_call_output").map((m: Wire) => m.call_id), ["call_one", "call_two"]);
		} else {
			const results = second!.messages.flatMap((m: Wire) => m.content).filter((block: Wire) => block.type === "tool_result");
			assert.deepEqual(results.map((block: Wire) => [block.tool_use_id, block.is_error]), [["call_one", false], ["call_two", true]]);
		}
	});
}
