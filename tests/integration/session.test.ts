import assert from "node:assert/strict";
import { existsSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { appendEntry, createSessionFile, findMostRecentSession, listSessions, loadSession, sessionTitleFromUserText } from "../../src/harness/session.ts";
import type { AssistantMessage, UserMessage } from "../../src/types.ts";
import { tempWorkspace } from "../support/fixtures.ts";
import { createTestHarness } from "../support/harness.ts";

const user = (text: string): UserMessage => ({ role: "user", content: [{ type: "text", text }], timestamp: 1 });
const assistant = (text: string): AssistantMessage => ({ role: "assistant", content: [{ type: "text", text }], model: "test", stopReason: "stop", timestamp: 2 });

test("sessions flush only after an assistant response and round-trip Unicode and multiline content", (t) => {
	const root = tempWorkspace(t), session = createSessionFile(root, join(root, "sessions"));
	appendEntry(session, { type: "message", message: user("你好\n世界") });
	assert.equal(existsSync(session.path), false);
	appendEntry(session, { type: "message", message: assistant("answer\n😀") });
	const loaded = loadSession(session.path);
	assert.deepEqual(loaded.messages, [user("你好\n世界"), assistant("answer\n😀")]);
	assert.equal(loaded.name, "你好 世界");
	assert.equal(sessionTitleFromUserText("  \t\n"), "untitled");
	assert.equal(sessionTitleFromUserText("abcdefghijk"), "abcdefghij");
});

test("discovery isolates projects, orders by mtime and ignores corrupt files", (t) => {
	const root = tempWorkspace(t), sessions = join(root, "sessions");
	const first = createSessionFile(root, sessions), second = createSessionFile(root, sessions);
	for (const [session, text] of [[first, "first"], [second, "second"]] as const) {
		appendEntry(session, { type: "message", message: user(text) });
		appendEntry(session, { type: "message", message: assistant("ok") });
	}
	utimesSync(first.path, new Date("2020-01-01"), new Date("2020-01-01"));
	utimesSync(second.path, new Date("2021-01-01"), new Date("2021-01-01"));
	writeFileSync(join(first.path, "..", "broken.jsonl"), "{broken");
	assert.deepEqual(listSessions(root, sessions).map((session) => session.name), ["second", "first"]);
	assert.equal(findMostRecentSession(root, sessions), second.path);
	assert.deepEqual(listSessions(join(root, "other-project"), sessions), []);
});

for (const [name, text] of [
	["empty", ""], ["invalid JSON", "{broken"], ["wrong version", JSON.stringify({ type: "session", version: 99 })],
	["invalid settings", JSON.stringify({ type: "session", version: 1, id: "x", timestamp: "2020-01-01", cwd: "/" }) + '\n{"type":"settings","thinking":{"effort":"unknown"}}'],
] as const) test(`loading ${name} session data fails without rewriting it`, (t) => {
	const path = join(tempWorkspace(t), "bad.jsonl");
	writeFileSync(path, text);
	assert.throws(() => loadSession(path));
	assert.equal(readFileSync(path, "utf8"), text);
});

test("compaction rebuilds the summary and retained tail while preserving the original log", (t) => {
	const root = tempWorkspace(t), session = createSessionFile(root, join(root, "sessions"));
	appendEntry(session, { type: "message", message: user("old") });
	appendEntry(session, { type: "message", message: assistant("old reply") });
	appendEntry(session, { type: "compaction", summary: "summary", keptMessages: [user("recent"), assistant("recent reply")] });
	const loaded = loadSession(session.path);
	assert.equal(loaded.entries.length, 3);
	assert.deepEqual(loaded.messages.slice(1), [user("recent"), assistant("recent reply")]);
	assert.match(readFileSync(session.path, "utf8"), /old reply/);
});

test("new and resume restore the saved conversation without creating a blank file", async (t) => {
	const { harness, agent } = createTestHarness(t, [{ text: "first answer" }, { text: "second answer" }]);
	await harness.prompt("first user");
	const saved = structuredClone(agent.state.messages);
	harness.newSession();
	assert.deepEqual(agent.state.messages, []);
	assert.equal(harness.listSessions().length, 1);
	assert.equal(harness.resumeAt(1), true);
	assert.deepEqual(agent.state.messages, saved);
	await harness.prompt("continue");
	assert.equal(loadSession(harness.listSessions()[0]!.filePath).messages.length, 4);
});
