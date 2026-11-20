import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { normalizeMcpResult, toDraft } from "../../src/mcp/content.ts";
import type { McpContent, McpServerBinding } from "../../src/mcp/types.ts";
import { tempWorkspace } from "../support/fixtures.ts";

const server: McpServerBinding = { serverId: "docs", generation: 1, identity: "key", toolRevision: 1, capabilities: { tools: true, resources: true, prompts: true }, tools: [], outputMaxBytes: 32768 };
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j9WQAAAAASUVORK5CYII=";
test("MCP content handles structured JSON deduplication, linked and embedded data, image, audio and unknown blocks", async t => {
	const root = tempWorkspace(t);
	const blocks: McpContent[] = [{ type: "text", text: '{ "b": 2, "a": 1 }' }, { type: "image", data: png, mimeType: "image/png" },
		{ type: "resource_link", uri: "file:///etc/passwd", name: "reference", mimeType: "text/plain" }, { type: "resource", resource: { uri: "mem://one", text: "embedded" } },
		{ type: "audio", data: "YWJj", mimeType: "audio/mpeg" }, { type: "other" } as unknown as McpContent];
	const result = await normalizeMcpResult(server, "lookup", { content: blocks, structuredContent: { a: 1, b: 2 }, isError: true }, { outputDirectory: root }, Date.now());
	assert.equal(result.isError, true);
	assert.deepEqual(result.content[0], { type: "text", text: "[MCP tool error]" });
	assert.equal(result.content.filter(b => b.type === "image").length, 1);
	const texts = result.content.filter(b => b.type === "text").map(b => b.text);
	assert.equal(texts.filter(s => s.includes('"b"')).length, 1);
	assert.match(texts.join("\n"), /file:\/\/\/etc\/passwd/);
	assert.match(texts.join("\n"), /embedded/);
	assert.match(texts.join("\n"), /Unsupported MCP content: other/);
	assert.equal(result.details.attachments.length, 1);
	assert.equal(await readFile(result.details.attachments[0]!.path, "utf8"), "abc");
});

test("MCP content budgets aggregate UTF-8 bytes and publishes the complete text only after writing", async t => {
	const root = tempWorkspace(t), serverLimit = { ...server, outputMaxBytes: 7 };
	const result = await normalizeMcpResult(serverLimit, "lookup", { content: [{ type: "text", text: "你好" }, { type: "text", text: "你好" }] },
		{ outputDirectory: root }, Date.now());
	assert.equal(result.details.truncated, true);
	assert.equal(result.content[0]!.type === "text" && result.content[0]!.text, "你好\n");
	assert.doesNotMatch(JSON.stringify(result.content), /�/u);
	assert.equal(await readFile(result.details.attachments[0]!.path, "utf8"), "你好\n你好");
	assert.equal((await readdir(root)).length, 1);
	await assert.rejects(normalizeMcpResult(serverLimit, "lookup", { content: [{ type: "text", text: "long enough" }] },
		{ outputDirectory: join(result.details.attachments[0]!.path, "directory") }, Date.now()));
});

test("MCP image fallback preserves bytes and invalid attachment encoding or MIME produces an error", async t => {
	const outputDirectory = tempWorkspace(t);
	const binary = await normalizeMcpResult(server, "lookup", { content: [{ type: "resource", resource: { uri: "file:///outside", mimeType: "image/png", blob: png } }] },
		{ outputDirectory, images: false }, Date.now());
	assert.ok(binary.content.every(block => block.type === "text"));
	assert.equal((await readFile(binary.details.attachments[0]!.path)).toString("base64"), png);
	for (const [data, mimeType] of [["!!", "image/png"], [png, "image/jpeg"], ["", "image/png"]]) {
		await assert.rejects(normalizeMcpResult(server, "lookup", { content: [{ type: "image", data: data!, mimeType: mimeType! }] }, { outputDirectory }, Date.now()), /base64|MIME|图片内容为空/);
	}
	const emptyError = await normalizeMcpResult(server, "lookup", { content: [], isError: true }, { outputDirectory }, Date.now());
	assert.match(JSON.stringify(emptyError.content), /MCP tool error/);
	await assert.rejects(normalizeMcpResult(server, "lookup", { content: [] }, { outputDirectory, signal: AbortSignal.abort() }, Date.now()));
});

test("MCP bounds binary file count and preserves oversized draft provenance and payload without private protocol metadata", async t => {
	const outputDirectory = tempWorkspace(t), source = "[MCP docs · " + "parameter".repeat(1800) + "]";
	const audio: McpContent = { type: "audio", mimeType: "audio/wav", data: "YWJj", _meta: { connection: "PRIVATE_METADATA" } };
	const result = await normalizeMcpResult({ ...server, outputMaxBytes: 40 }, "many", { content: Array<McpContent>(35).fill(audio) },
		{ outputDirectory }, Date.now());
	const pack = result.details.attachments.find(attachment => attachment.mimeType === "application/json")!;
	assert.notEqual(pack, undefined);
	const encoded = await readFile(pack.path, "utf8");
	assert.equal(JSON.parse(encoded).length, 3);
	assert.doesNotMatch(encoded, /PRIVATE_METADATA/);
	assert.ok(result.details.attachments.length < 35);
	const draft = await toDraft(result, source, { outputDirectory }, 40);
	assert.match(draft.text, /Complete MCP source/);
	assert.match(draft.text, /full text/);
	assert.ok(Buffer.byteLength(draft.text) < Buffer.byteLength(source));
	assert.equal(await readFile(draft.details.attachments.at(-1)!.path, "utf8"), source);
});
