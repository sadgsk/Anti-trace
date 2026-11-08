import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { createReadTool } from "../../src/harness/tools/read.ts";
import { createWriteTool } from "../../src/harness/tools/write.ts";
import { createEditTool } from "../../src/harness/tools/edit.ts";
import { tempWorkspace } from "../support/fixtures.ts";

test("write creates nested paths with spaces and reports UTF-8 bytes", async (t) => {
	const root = tempWorkspace(t);
	const tool = createWriteTool(root);
	const result = await tool.execute("write", { path: "nested folder/a.txt", content: "你好\n" });
	assert.equal(readFileSync(join(root, "nested folder", "a.txt"), "utf8"), "你好\n");
	assert.equal(result.details.bytes, 7);
	assert.equal(result.details.created, true);
	const replaced = await tool.execute("replace", { path: "nested folder/a.txt", content: "changed\n" });
	assert.equal(replaced.details.created, false);
	assert.ok(replaced.details.hunks?.length);
});

test("read normalizes CRLF, numbers selected lines and reports continuation", async (t) => {
	const root = tempWorkspace(t);
	writeFileSync(join(root, "a.txt"), "one\r\ntwo\r\nthree");
	const tool = createReadTool(root);
	const result = await tool.execute("read", { path: "a.txt", offset: 2, limit: 1 });
	assert.match(result.content[0]?.type === "text" ? result.content[0].text : "", /^2\|two\n\n.*offset=3/);
	assert.equal(result.details.totalLines, 3);
	await assert.rejects(tool.execute("missing", { path: "missing" }), /File not found/);
	await assert.rejects(tool.execute("offset", { path: "a.txt", offset: 5 }), /beyond end/);
});

test("large reads truncate at line and byte limits without cutting multibyte text", async (t) => {
	const root = tempWorkspace(t);
	const tool = createReadTool(root);
	writeFileSync(join(root, "lines.txt"), Array.from({ length: 2001 }, (_, i) => `line ${i}`).join("\n"));
	const lines = await tool.execute("lines", { path: "lines.txt" });
	assert.equal(lines.details.endLine, 2000);
	assert.equal(lines.details.truncated, true);
	writeFileSync(join(root, "bytes.txt"), "中".repeat(18000));
	const bytes = await tool.execute("bytes", { path: "bytes.txt" });
	assert.equal(bytes.details.truncated, true);
	assert.match(bytes.content[0]?.type === "text" ? bytes.content[0].text : "", /exceeds 50KB/);
});

test("disjoint edits apply against the original file and produce a diff", async (t) => {
	const root = tempWorkspace(t);
	writeFileSync(join(root, "a.txt"), "alpha beta gamma\n");
	const result = await createEditTool(root).execute("edit", { path: "a.txt", edits: [
		{ oldText: "alpha", newText: "A" }, { oldText: "gamma", newText: "C" },
	] });
	assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "A beta C\n");
	assert.equal(result.details.replacements, 2);
	assert.ok(result.details.hunks.length);
});

for (const [name, original, edits, expected] of [
	["missing match", "alpha", [{ oldText: "absent", newText: "x" }], /Could not find/],
	["ambiguous match", "foo foo", [{ oldText: "foo", newText: "x" }], /2 occurrences/],
	["overlapping edits", "abcdef", [{ oldText: "abc", newText: "x" }, { oldText: "bc", newText: "y" }], /overlap/],
	["unchanged replacement", "alpha", [{ oldText: "alpha", newText: "alpha" }], /No changes/],
	["empty match", "alpha", [{ oldText: "", newText: "x" }], /oldText is empty/],
] as const) test(`edit rejects ${name} without changing the file`, async (t) => {
	const root = tempWorkspace(t);
	const file = join(root, "a.txt");
	writeFileSync(file, original);
	await assert.rejects(createEditTool(root).execute("edit", { path: "a.txt", edits: edits.map((edit) => ({ ...edit })) }), expected);
	assert.equal(readFileSync(file, "utf8"), original);
});

test("pre-aborted read/write/edit operations have no filesystem effects", async (t) => {
	const root = tempWorkspace(t);
	writeFileSync(join(root, "a.txt"), "original");
	const signal = AbortSignal.abort();
	await assert.rejects(createReadTool(root).execute("read", { path: "a.txt" }, signal), /Aborted/);
	await assert.rejects(createWriteTool(root).execute("write", { path: "new.txt", content: "x" }, signal), /Aborted/);
	await assert.rejects(createEditTool(root).execute("edit", { path: "a.txt", edits: [{ oldText: "original", newText: "changed" }] }, signal), /Aborted/);
	assert.equal(existsSync(join(root, "new.txt")), false);
	assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "original");
});
