import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { PassThrough, Writable } from "node:stream";
import { render } from "ink";
import { ReplController } from "../../src/cli/repl/repl-controller.ts";
import { createPromptDraft } from "../../src/cli/input/prompt-draft.ts";
import { SLASH_COMMANDS } from "../../src/cli/commands/command-registry.ts";
import { CommandDialog } from "../../src/tui/commands/CommandDialog.tsx";
import { TranscriptItemView } from "../../src/tui/messages/TranscriptView.tsx";
import type { ToolUseItem } from "../../src/tui/transcript.ts";
import { createTestHarness, messageText } from "../support/harness.ts";
import { writeSkill } from "../support/skills.ts";
import { waitFor } from "../support/fixtures.ts";

function accept(repl: ReplController) { repl.dialogs.target.actions!["dialog:accept"]!({ type: "text", text: "\r" }); }

test("only /skill appears at top level; its second-level menu is dynamic and opening or cancelling sends no model request", async t => {
	const f = createTestHarness(t, [], { unconfigured: true });
	writeSkill(f.root, "review"); writeSkill(f.root, "automatic", "auto", { "user-invocable": false });
	const repl = new ReplController({ harness: f.harness, cwd: f.root, interactive: true }); t.after(() => repl.dispose());
	assert.ok(SLASH_COMMANDS.some(command => command.name === "skill"));
	assert.equal(SLASH_COMMANDS.some(command => (command.name as string) === "review"), false);
	await repl.submit(createPromptDraft("/skill"));
	const state = repl.dialogs.getSnapshot(); assert.equal(state?.kind, "picker");
	if (state?.kind === "picker") assert.deepEqual(state.choices.map(choice => choice.id), ["review", ":reload"]);
	assert.equal(f.scripted.requests.length, 0);
	repl.dialogs.cancel(); assert.equal(repl.dialogs.getSnapshot(), null);
	writeSkill(f.root, "new-skill"); await repl.submit(createPromptDraft("/skill"));
	const refreshed = repl.dialogs.getSnapshot();
	assert.ok(refreshed?.kind === "picker" && refreshed.choices.some(choice => choice.id === "new-skill"));
	assert.equal(f.scripted.requests.length, 0);
});

test("selecting a skill collects optional arguments, runs once, and uses the real harness", async t => {
	const f = createTestHarness(t, [{ text: "review done" }]);
	writeSkill(f.root, "review", "REVIEW_SCOPE=$ARGUMENTS", { "argument-hint": "[scope]" });
	const repl = new ReplController({ harness: f.harness, cwd: f.root, interactive: true }); t.after(() => repl.dispose());
	await repl.submit(createPromptDraft("/skill")); accept(repl);
	assert.equal(repl.dialogs.getSnapshot()?.kind, "input");
	assert.equal(f.scripted.requests.length, 0);
	repl.dialogs.editor.replaceText("当前分支"); accept(repl); accept(repl);
	await waitFor(() => !repl.getSnapshot().busy, "skill execution");
	assert.equal(f.scripted.requests.length, 1);
	assert.match(f.scripted.requests[0]!.context.messages.map(messageText).join("\n"), /REVIEW_SCOPE=当前分支/);
	assert.equal(repl.dialogs.getSnapshot(), null);
	assert.equal(repl.getSnapshot().error, undefined);
});

test("argument cancellation returns to skill selection and empty or malformed directories stay usable", async t => {
	const f = createTestHarness(t, [], { unconfigured: true });
	const repl = new ReplController({ harness: f.harness, cwd: f.root, interactive: true }); t.after(() => repl.dispose());
	await repl.submit(createPromptDraft("/skill"));
	assert.match(repl.dialogs.getSnapshot()?.description ?? "", /尚无/); repl.dialogs.cancel();
	writeSkill(f.root, "review", "body", { "argument-hint": "scope" });
	writeSkill(f.root, "broken", "body", { description: "" });
	await repl.submit(createPromptDraft("/skill")); accept(repl); repl.dialogs.cancel();
	assert.equal(repl.dialogs.getSnapshot()?.kind, "picker");
	assert.equal(f.scripted.requests.length, 0);
	repl.dialogs.cancel(); await repl.submit(createPromptDraft("/skill --reload"));
	assert.match(repl.getSnapshot().entries.map(entry => entry.text).join("\n"), /description must contain/);
});

test("skill selection renders through the existing modal at narrow and normal widths", async t => {
	const f = createTestHarness(t); writeSkill(f.root, "review");
	const repl = new ReplController({ harness: f.harness, cwd: f.root, interactive: true }); t.after(() => repl.dispose());
	await repl.submit(createPromptDraft("/skill"));
	for (const columns of [28, 80]) {
		const frames: string[] = [], stdin = new PassThrough();
		const stdout = Object.assign(new Writable({ write(chunk, _encoding, done) { frames.push(String(chunk)); done(); } }), { columns, rows: 14, isTTY: false });
		const app = render(createElement(CommandDialog, { controller: repl.dialogs, columns, rows: 14 }), { stdin: stdin as unknown as NodeJS.ReadStream, stdout: stdout as unknown as NodeJS.WriteStream, debug: true, patchConsole: false, exitOnCtrlC: false });
		try { await waitFor(() => frames.some(frame => frame.includes("review")), "rendered skill choice"); assert.match(frames.at(-1)!, /review/); }
		finally { app.unmount(); app.cleanup(); stdin.destroy(); stdout.destroy(); }
	}
});

test("skill tool cards show the selected name, safe arguments and errors without exposing injected instructions", async () => {
	const frames: string[] = [], stdin = new PassThrough();
	const stdout = Object.assign(new Writable({ write(chunk, _encoding, done) { frames.push(String(chunk)); done(); } }), { columns: 80, rows: 20, isTTY: false });
	const item: ToolUseItem = { id: 1, kind: "tool", callId: "load", name: "skill", args: { skill: "review", args: "branch\r\n\u001b[2J" }, status: "success", startedAt: 1,
		result: { content: [{ type: "text", text: "Loaded skill: review" }], details: { path: "review/SKILL.md" },
			newMessages: [{ role: "user", isMeta: true, timestamp: 1, content: [{ type: "text", text: "PRIVATE_INJECTED_INSTRUCTIONS" }] }] } };
	const props = { item, expanded: true, thinkingDisplay: false, columns: 80 };
	const app = render(createElement(TranscriptItemView, props), { stdin: stdin as unknown as NodeJS.ReadStream, stdout: stdout as unknown as NodeJS.WriteStream, debug: true, patchConsole: false, exitOnCtrlC: false });
	try {
		await waitFor(() => frames.some(frame => frame.includes("Loaded skill")), "skill tool card");
		const frame = frames.find(frame => frame.includes("Loaded skill"))!;
		assert.match(frame, /Skill.*review/); assert.match(frame, /review\/SKILL.md/); assert.match(frame, /branch/);
		assert.doesNotMatch(frame, /PRIVATE_INJECTED_INSTRUCTIONS|\x1b\[2J/);
		app.rerender(createElement(TranscriptItemView, { ...props, item: { ...item, status: "error", result: { content: [{ type: "text", text: "Unknown skill: review" }], details: {} } } }));
		await waitFor(() => frames.some(value => value.includes("Unknown skill")), "skill tool error");
	} finally { app.unmount(); app.cleanup(); stdin.destroy(); stdout.destroy(); }
});
