import assert from "node:assert/strict";
import { existsSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { appendEntry, appendToolCheckpoint, createSessionFile, findMostRecentSession, listSessions, loadSession, sessionTitleFromUserText } from "../../src/harness/session.ts";
import type { AssistantMessage, ToolCall, ToolResultMessage, UserMessage } from "../../src/types.ts";
import { tempWorkspace } from "../support/fixtures.ts";
import { createTestHarness } from "../support/harness.ts";
import { projectSessionHistory } from "../../src/tui/transcript.ts";

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

for (const crash of ["streaming", "assistant committed", "first result committed", "terminal batch"] as const) {
	test(`resume pairs calls once in source order after a crash with ${crash}`, async t => {
		const { root, sessionsRoot, harness, agent } = createTestHarness(t);
		const file = createSessionFile(root, sessionsRoot);
		appendEntry(file, { type: "message", message: user("make both changes") });
		const calls: ToolCall[] = ["first", "second"].map(id => ({
			type: "toolCall", name: "write", id, arguments: { path: id, content: "done" },
		}));
		const model = "test", timestamp = 3;
		// Admission can differ from model order, and result 2 can finish before result 1.
		if (crash !== "terminal batch") {
			for (const index of [1, 0]) appendToolCheckpoint(file, { type: "stream_tool_start", index, model, timestamp, call: calls[index]! });
		}
		const known: ToolResultMessage = { role: "toolResult", toolCallId: "second", toolName: "write",
			content: [{ type: "text", text: "completed second write" }], details: { bytes: 4 }, timestamp: 4, isError: false };
		if (crash !== "terminal batch") appendToolCheckpoint(file, { type: "stream_tool_result", message: known });
		if (crash !== "streaming") appendEntry(file, { type: "message", message: {
			role: "assistant", content: calls, model, timestamp, stopReason: "toolUse" } });
		if (crash === "terminal batch") appendToolCheckpoint(file, { type: "stream_tool_result", message: known });
		if (crash === "first result committed") appendEntry(file, { type: "message", message: {
			...known, toolCallId: "first", content: [{ type: "text", text: "completed first write" }] } });

		assert.equal(await harness.resumeAt(1), true);
		const messages = agent.state.messages;
		const results = messages.filter(message => message.role === "toolResult");
		assert.deepEqual(results.map(message => message.toolCallId), ["first", "second"]);
		assert.deepEqual(results[1], known);
		assert.equal(results[0]?.isError, crash !== "first result committed");
		const reply = messages.find(message => message.role === "assistant");
		assert.equal(reply?.partialToolExecution, crash === "streaming" || undefined);
		assert.deepEqual(reply?.content, calls);
		const saved = readFileSync(file.path, "utf8");
		assert.equal(await harness.resumeAt(1), true);
		assert.equal(readFileSync(file.path, "utf8"), saved);
		assert.deepEqual(loadSession(file.path).messages, messages);
	});
}

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

for (const recovered of [true, false]) test(`restored history distinguishes recovered attempts from final errors (recovered=${recovered})`, (t) => {
	const root = tempWorkspace(t), session = createSessionFile(root, join(root, "sessions"));
	appendEntry(session, { type: "message", message: user("task") });
	appendEntry(session, { type: "message", message: { ...assistant(""), stopReason: "error", errorMessage: "original overflow" } });
	appendEntry(session, { type: "compaction", summary: "summary", keptMessages: [user("task")], ...(recovered ? { replacesError: true } : {}) });
	appendEntry(session, { type: "message", message: { ...assistant(""), stopReason: "error", errorMessage: "retry failed" } });
	const loaded = loadSession(session.path);
	let id = 0;
	const notices = projectSessionHistory(loaded.entries, () => id++).filter(item => item.kind === "notice" && item.tone === "error");
	assert.deepEqual(notices.map(item => item.kind === "notice" ? item.text : ""), recovered ? ["retry failed"] : ["original overflow", "retry failed"]);
	assert.match(readFileSync(session.path, "utf8"), /original overflow/, "original diagnostics stay in the raw log");
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
