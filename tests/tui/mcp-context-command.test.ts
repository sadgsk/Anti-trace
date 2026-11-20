import assert from "node:assert/strict";
import { join } from "node:path";
import { readdirSync, readFileSync } from "node:fs";
import { PassThrough, Readable } from "node:stream";
import test, { type TestContext } from "node:test";
import { ReplController, type ReplHarness } from "../../src/cli/repl/repl-controller.ts";
import { runCli } from "../../src/cli/main.ts";
import { McpRuntime } from "../../src/mcp/runtime.ts";
import { PromptInputController } from "../../src/cli/input/prompt-input-controller.ts";
import { preparePromptSubmission } from "../../src/cli/input/prompt-draft.ts";
import { tempWorkspace, waitFor } from "../support/fixtures.ts";
import { createHttpFixture } from "../support/http-server.ts";
const gif = "R0lGODdhAQABAIAAAAAAAP///yH5BAQAAAAALAAAAAABAAEAAAICTAEAOw==";

async function fixture(t: TestContext) {
	const requests: { method: string; params?: { uri?: string; arguments?: Record<string,string> } }[] = [];
	const http = await createHttpFixture(t, ({ body }, res) => {
		const req = body as { id?: number | string; method: string; params?: { uri?: string; arguments?: Record<string,string> } } | undefined;
		if (!req) { res.writeHead(405).end(); return; }
		requests.push(req);
		if (req.id === undefined) { res.writeHead(202).end(); return; }
		const reply = (result: unknown) => res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: req.id, result }));
		switch (req.method) {
			case "initialize": reply({ protocolVersion: "2025-11-25", capabilities: { resources: {}, prompts: {} }, serverInfo: { name: "test", version: "1" } }); break;
			case "resources/list": reply({ resources: [{ name: "guide", uri: "docs://guide" }] }); break;
			case "resources/templates/list": reply({ resourceTemplates: [{ name: "notes", uriTemplate: "docs://notes{/id}" }] }); break;
			case "resources/read": reply({ contents: [req.params?.uri === "docs://image" ? { uri: req.params.uri, mimeType: "image/gif", blob: gif }
				: { uri: req.params?.uri, text: "resource snapshot" }] }); break;
			case "prompts/list": reply({ prompts: [{ name: "review", arguments: [{ name: "topic", required: true }] }] }); break;
			case "prompts/get": reply({ messages: [
				{ role: "user", content: { type: "text", text: "Review " + req.params?.arguments?.topic } },
				{ role: "assistant", content: { type: "text", text: req.params?.arguments?.topic === "long" ? "x".repeat(70000) + "RAW_END" : "example answer" } },
			] }); break;
			default: res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: req.id, error: { code: -32601, message: "unknown method" } }));
		}
	});
	const root = tempWorkspace(t, async () => { repl.dispose(); editor.dispose(); await mcp.close(); });
	const mcp = new McpRuntime({ cwd: root, appHome: join(root, "home") });
	await mcp.save("user", "docs", { type: "http", url: http.url });
	let modelCalls = 0;
	const harness: ReplHarness = { mcp, prompt: async () => { modelCalls++; }, abort() {}, subscribe: () => () => {},
		newSession() {}, listSessions: () => [], resumeAt: () => false, setContextWindow() {}, contextUsage: () => ({ used: 0, window: undefined }), manualCompact: async () => "nothing-to-compact" };
	const editor = new PromptInputController({ availableColumns: 78 });
	const repl = new ReplController({ harness, cwd: root, interactive: true, getDraftEditor: () => editor, onAccept: () => editor.reset() });
	const submit = (text: string) => { editor.textInput.replaceText(text); return repl.submit(editor.getDraft()); };
	const action = (name: string) => repl.dialogs.target.actions?.["dialog:" + name]?.({ type: "key", name: "enter", raw: "", ctrl: false, alt: false, shift: false, meta: false });
	const state = () => repl.dialogs.getSnapshot();
	const at = (kind: string, title?: string) => waitFor(() => state()?.kind === kind && (!title || state()?.title === title), title ?? kind);
	const pipe = async (input: string) => {
		const stdout = new PassThrough(), stderr = new PassThrough(); let output = "";
		stdout.on("data", data => { output += data.toString(); });
		const code = await runCli({ cwd: root, harness, streams: { stdin: Readable.from([input]), stdout, stderr } });
		return { output, code };
	};
	return { requests, mcp, submit, repl, editor, action, state, at, pipe, modelCalls: () => modelCalls };
}

test("MCP resource preview, cancellation, atomic insertion and undo preserve the draft without a model", async t => {
	const f = await fixture(t);
	const cmd = "/mcp-resource docs docs://guide";
	const cancelled = f.submit(cmd); await f.at("preview"); f.action("cancel"); await cancelled;
	assert.equal(f.editor.getDraft().text, cmd);
	const accepted = f.submit(cmd); await f.at("preview"); f.action("accept"); await accepted;
	assert.match(f.editor.getDraft().text, /resource snapshot/);
	assert.match(f.editor.getDraft().text, /docs:\/\/guide/);
	assert.equal(f.modelCalls(), 0);
	f.editor.handleAction("input:undo"); assert.equal(f.editor.getDraft().text, cmd);
	f.editor.handleAction("input:redo"); await f.repl.submit(f.editor.getDraft()); assert.equal(f.modelCalls(), 1);
});

test("MCP draft revision conflicts require confirmation and retain concurrent edits", async t => {
	const f = await fixture(t);
	const work = f.submit('/mcp-prompt docs review {\n  "topic": "the current branch"\n}');
	await f.at("preview");
	f.action("right");
	const raw = f.state(); assert.ok(raw?.kind === "preview" && raw.showingRaw && raw.text.includes('"assistant"'));
	f.editor.textInput.replaceText("new draft\n");
	f.action("accept"); await f.at("preview", "草稿已修改，插入到当前光标？");
	assert.equal(f.editor.getDraft().text, "new draft\n");
	f.action("accept"); await work;
	const draft = preparePromptSubmission(f.editor.getDraft());
	assert.match(draft.text, /^new draft\n/); assert.match(draft.text, /the current branch/); assert.match(draft.text, /example answer/);
	f.editor.handleAction("input:undo"); assert.equal(f.editor.getDraft().text, "new draft\n");
	assert.equal(f.modelCalls(), 0);
});

test("MCP picker expands URI template variables, previews the address and reads once", async t => {
	const f = await fixture(t), work = f.submit("/mcp-resource");
	await f.at("picker", "选择 MCP 服务器"); f.action("accept");
	await f.at("picker", "MCP 资源"); f.action("next"); f.action("accept");
	await f.at("form", "资源模板参数"); f.action("accept"); f.repl.dialogs.editor.replaceText("a/b x"); f.action("accept"); f.action("save");
	await f.at("preview", "读取资源 URI");
	assert.equal(f.requests.filter(r => r.method === "resources/read").length, 0);
	f.action("accept"); await f.at("preview", "MCP 内容预览"); f.action("accept"); await work;
	assert.deepEqual(f.requests.filter(r => r.method === "resources/read").map(r => r.params?.uri), ["docs://notes/a%2Fb%20x"]);
	assert.equal(f.modelCalls(), 0);
});

test("MCP prompt form validates required fields and explicit fetch failures preserve the command", async t => {
	const f = await fixture(t), work = f.submit("/mcp-prompt docs");
	await f.at("picker", "MCP 提示模板"); f.action("accept");
	await f.at("form", "提示模板参数"); f.action("save");
	assert.match(f.state()?.error ?? "", /topic/);
	assert.equal(f.requests.filter(r => r.method === "prompts/get").length, 0);
	f.action("accept"); f.repl.dialogs.editor.replaceText("menu selection"); f.action("accept"); f.action("save");
	await f.at("preview"); f.action("cancel"); await work;
	assert.equal(f.editor.getDraft().text, "/mcp-prompt docs");
	await f.mcp.setEnabled("docs", false);
	await f.submit("/mcp-resource docs docs://guide");
	assert.match(f.repl.getSnapshot().error ?? "", /停用/);
	assert.equal(f.editor.getDraft().text, "/mcp-resource docs docs://guide");
	assert.equal(f.requests.filter(r => r.method === "resources/read").length, 0);
	assert.equal(f.modelCalls(), 0);
});

test("MCP pipe commands accept a trailing newline, preserve JSON strings, and reject invalid arguments before fetching", async t => {
	const f = await fixture(t);
	const valid = await f.pipe('/mcp-prompt docs review {"topic":"space and 中文"}\r\n');
	assert.equal(valid.code, 0, valid.output); assert.match(valid.output, /Review space and 中文/); assert.match(valid.output, /example answer/);
	const multiline = await f.pipe('/mcp-prompt docs review {\r\n  "topic": "multiple lines"\r\n}\r\n');
	assert.equal(multiline.code, 0, multiline.output); assert.match(multiline.output, /Review multiple lines/);
	const resource = await f.pipe("/mcp-resource docs file://remote/only\n");
	assert.equal(resource.code, 0, resource.output); assert.match(resource.output, /file:\/\/remote\/only/);
	for (const args of ['{}', '{"topic":23}', 'not-json']) {
		const bad = await f.pipe("/mcp-prompt docs review " + args); assert.equal(bad.code, 1, bad.output);
	}
	assert.equal(f.requests.filter(r => r.method === "prompts/get").length, 2);
	assert.equal(f.modelCalls(), 0);
});

test("MCP preview can page through the complete original prompt after draft truncation; pipe images become readable files", async t => {
	const f = await fixture(t), pending = f.submit('/mcp-prompt docs review {"topic":"long"}');
	await f.at("preview"); const draft = f.state();
	assert.ok(draft?.kind === "preview" && !draft.text.includes("RAW_END"));
	f.action("right");
	const raw = f.state(); assert.ok(raw?.kind === "preview" && raw.showingRaw && raw.pages > 1);
	for (let i = 1; i < raw.pages; i++) f.action("page-next");
	const last = f.state(); assert.ok(last?.kind === "preview" && last.page === raw.pages - 1 && last.lines.join("").includes("RAW_END"));
	f.action("cancel"); await pending;
	const image = await f.pipe("/mcp-resource docs docs://image\n");
	assert.equal(image.code, 0, image.output);
	const dir = join(f.mcp.toolResultsDir, "mcp"), filename = readdirSync(dir).find(f => f.endsWith(".gif"));
	assert.ok(filename && image.output.includes(join(dir, filename)));
	assert.equal(readFileSync(join(dir, filename)).toString("base64"), gif);
	assert.ok(!image.output.includes(gif));
});
