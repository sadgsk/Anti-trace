import assert from "node:assert/strict";
import test from "node:test";
import { PromptInputController } from "../../src/cli/input/prompt-input-controller.ts";
import { preparePromptSubmission } from "../../src/cli/input/prompt-draft.ts";
import { expandResourceTemplate, templateVariables } from "../../src/mcp/uri-template.ts";

test("MCP draft insertion commits text and image references in a single undoable revision", t => {
	const editor = new PromptInputController({ availableColumns: 60 });
	t.after(() => editor.dispose());
	editor.textInput.replaceText("/mcp-resource demo file://report");
	const command = editor.getDraft();
	const rev = editor.getRevision();
	const image = { type: "image" as const, mimeType: "image/png", data: "AQ==" };
	assert.ok(editor.insertMaterial({ text: "snapshot", images: [image] }, rev, true));
	assert.deepEqual(preparePromptSubmission(editor.getDraft()), { text: "snapshot ", images: [image] });
	editor.handleAction("input:undo"); assert.deepEqual(editor.getDraft(), command);
	assert.equal(editor.insertMaterial({ text: "late", images: [] }, rev, true), false);
	editor.handleAction("input:redo");
	editor.textInput.replaceRange(0, 0, "more ");
	assert.deepEqual(preparePromptSubmission(editor.getDraft()), { text: "more snapshot ", images: [image] });
	editor.handleAction("input:home");
	assert.ok(editor.insertMaterial({ text: "add", images: [] }, editor.getRevision(), false));
	assert.match(editor.getDraft().text, /^addmore/);
	assert.deepEqual(preparePromptSubmission(editor.getDraft()).images, [image]);
});

test("MCP URI template expansion handles paths, Unicode, prefix limits, query and composite values", () => {
	const template = "fixture://docs{/term}{?query,omit,tag*}";
	assert.deepEqual(templateVariables(template), ["term", "query", "omit", "tag"]);
	assert.equal(expandResourceTemplate(template, { term: "中/a", query: "a b", tag: ["x", "y"] }), "fixture://docs/%E4%B8%AD%2Fa?query=a%20b&tag=x&tag=y");
	assert.equal(expandResourceTemplate("{+subpath}{#value:1}", { subpath: "x/a%20b", value: "🌿tree" }), "x/a%20b#%F0%9F%8C%BF");
	assert.equal(expandResourceTemplate("{;empty,key*}", { empty: "", key: { hello: "!", empty: "" } }), ";empty;hello=%21;empty");
	assert.equal(expandResourceTemplate("{?data}", { data: [] }), "");
	assert.equal(expandResourceTemplate("{?x,x}", { x: "1" }), "?x=1&x=1");
	for (const malformed of ["{test", "{?x,}", "{n:0001}", "{x*bad}", "{a/b}"]) assert.throws(() => templateVariables(malformed));
});
