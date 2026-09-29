import assert from "node:assert/strict";
import test from "node:test";
import { DraftEditor } from "../src/cli/input/stash/draft.ts";

test("multiline paste stays one editable draft and submits with indentation intact", () => {
	const draft = new DraftEditor();
	const pasted = "  await executeToolCallsSequential(\r\n\tcurrentContext,\r\n\tmessage,\r\n);\r\n";
	draft.insert(pasted);
	assert.equal(draft.text, "  await executeToolCallsSequential(\n\tcurrentContext,\n\tmessage,\n);\n");
	assert.deepEqual(draft.position, { row: 4, column: 0 });
	assert.equal(draft.submit(), "  await executeToolCallsSequential(\n\tcurrentContext,\n\tmessage,\n);\n");
	assert.equal(draft.text, "");
	assert.equal(draft.cursor, 0);
});

test("insertion, deletion and line navigation work across logical lines", () => {
	const draft = new DraftEditor("abcd\nx\nwxyz");
	draft.setCursor(3);
	assert.equal(draft.moveDown(), true);
	assert.deepEqual(draft.position, { row: 1, column: 1 });
	assert.equal(draft.moveDown(), true);
	assert.deepEqual(draft.position, { row: 2, column: 3 });
	assert.equal(draft.moveUp(), true);
	assert.deepEqual(draft.position, { row: 1, column: 1 });
	assert.equal(draft.moveHome(), true);
	assert.equal(draft.moveLeft(), true);
	assert.deepEqual(draft.position, { row: 0, column: 4 });
	assert.equal(draft.deleteForward(), true);
	assert.equal(draft.text, "abcdx\nwxyz");
	assert.equal(draft.moveEnd(), true);
	assert.equal(draft.backspace(), true);
	assert.equal(draft.text, "abcd\nwxyz");
});

test("cursor and deletion respect extended grapheme clusters", () => {
	const draft = new DraftEditor("A👩‍👩‍👧‍👦e\u0301Z");
	draft.setCursor(3); // In the middle of the family emoji's UTF-16 sequence.
	assert.equal(draft.cursor, 1);
	assert.equal(draft.moveRight(), true);
	assert.equal(draft.text.slice(draft.cursor), "e\u0301Z");
	assert.equal(draft.backspace(), true);
	assert.equal(draft.text, "Ae\u0301Z");
	assert.equal(draft.deleteForward(), true);
	assert.equal(draft.text, "AZ");
});

test("line endings normalize, but whitespace and history drafts stay intact", () => {
	const draft = new DraftEditor();
	draft.insert("  first \rsecond\r\n");
	assert.equal(draft.submit(), "  first \nsecond\n");
	draft.insert("unsent");
	assert.equal(draft.previousHistory(), true);
	assert.equal(draft.text, "  first \nsecond\n");
	assert.equal(draft.nextHistory(), true);
	assert.equal(draft.text, "unsent");
	draft.newline();
	assert.equal(draft.submit(), "unsent\n");
});
