import assert from "node:assert/strict";
import test from "node:test";
import { PasteBurst } from "../src/cli/input/stash/paste-burst.ts";

test("rapid unmarked lines are inserted as one paste, then a separate Enter submits", () => {
	const burst = new PasteBurst({ characterGapMs: 8, burstIdleMs: 60, enterGuardMs: 120 });
	const events = [];
	let now = 0;
	for (const char of "first") {
		events.push(...burst.feedText(char, now++));
	}
	events.push(...burst.feedDelimiter("enter", now++));
	for (const char of "second") {
		events.push(...burst.feedText(char, now++));
	}
	events.push(...burst.feedDelimiter("enter", now++));
	assert.deepEqual(events, []);
	assert.deepEqual(burst.flushIfDue(now + 60), [{ type: "paste", text: "first\nsecond\n" }]);
	assert.deepEqual(burst.feedDelimiter("enter", now + 250), []);
	assert.deepEqual(burst.flushIfDue(now + 259), [{ type: "key", key: "enter" }]);
});

test("normal typing and Enter remain a submit action", () => {
	const burst = new PasteBurst({ characterGapMs: 8, burstIdleMs: 60 });
	assert.deepEqual(burst.feedText("h", 0), []);
	assert.deepEqual(burst.feedText("i", 50), [{ type: "text", text: "h" }]);
	assert.deepEqual(burst.feedDelimiter("enter", 100), [{ type: "text", text: "i" }]);
	assert.deepEqual(burst.flushIfDue(109), [{ type: "key", key: "enter" }]);
});

test("a one-character first line cannot submit a rapid unmarked paste", () => {
	const burst = new PasteBurst({ characterGapMs: 8, burstIdleMs: 60 });
	assert.deepEqual(burst.feedText("a", 0), []);
	assert.deepEqual(burst.feedDelimiter("enter", 1), []);
	assert.deepEqual(burst.feedText("b", 2), []);
	assert.deepEqual(burst.flushIfDue(70), [{ type: "paste", text: "a\nb" }]);
});

test("a leading newline followed quickly by text is paste content", () => {
	const burst = new PasteBurst({ characterGapMs: 8, burstIdleMs: 60 });
	assert.deepEqual(burst.feedDelimiter("enter", 0), []);
	assert.deepEqual(burst.feedText("x", 1), []);
	assert.deepEqual(burst.flushIfDue(70), [{ type: "paste", text: "\nx" }]);
});

test("a late final newline just after a burst cannot submit", () => {
	const burst = new PasteBurst({ characterGapMs: 8, burstIdleMs: 60, enterGuardMs: 120 });
	for (let i = 0; i < 5; i += 1) burst.feedText("x", i);
	assert.deepEqual(burst.flushIfDue(70), [{ type: "paste", text: "xxxxx" }]);
	assert.deepEqual(burst.feedDelimiter("enter", 75), [{ type: "paste", text: "\n" }]);
});
