import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createReadTool } from "../../src/harness/tools/read.ts";
import { createWriteTool } from "../../src/harness/tools/write.ts";
import { loadSession } from "../../src/harness/session.ts";
import { projectMessages } from "../../src/tui/transcript.ts";
import { createTestHarness, messageText } from "../support/harness.ts";
import { assertToolPairs } from "../support/compaction.ts";
import { skillText, writeSkill } from "../support/skills.ts";
import { tempWorkspace } from "../support/fixtures.ts";
import { HISTORY_TEXT } from "../support/compaction.ts";

test("the model sees one skill tool and a catalog, then reads a selected skill and its resource", async t => {
	const f = createTestHarness(t);
	writeSkill(f.root, "review", "PRIVATE_REVIEW_INSTRUCTIONS: inspect $ARGUMENTS then read references/checklist.md.");
	mkdirSync(join(f.root, ".anti-trace", "skills", "review", "references"));
	writeFileSync(join(f.root, ".anti-trace", "skills", "review", "references", "checklist.md"), "CHECKLIST_RESOURCE");
	f.scripted.appendResponses(request => {
		assert.equal(request.context.tools?.filter(tool => tool.name === "skill").length, 1);
		assert.equal(request.context.tools?.some(tool => tool.name === "review"), false);
		const text = request.context.messages.map(messageText).join("\n");
		assert.match(text, /review: Use review/); assert.doesNotMatch(text, /PRIVATE_REVIEW_INSTRUCTIONS/);
		return { toolCalls: [{ id: "load", name: "skill", arguments: { skill: "review", args: "current diff" } }, { id: "read", name: "read", arguments: { path: ".anti-trace/skills/review/references/checklist.md" } }] };
	}, request => {
		assertToolPairs(request.context.messages);
		const toolResults = request.context.messages.filter(message => message.role === "toolResult");
		assert.deepEqual(toolResults.map(message => message.toolName), ["skill", "read"]);
		assert.match(messageText(toolResults[1]), /CHECKLIST_RESOURCE/);
		const instructionIndex = request.context.messages.findIndex(message => message.role === "user" && message.metadata?.kind === "skill");
		assert.ok(instructionIndex > request.context.messages.findIndex(message => message === toolResults[1]));
		assert.match(messageText(request.context.messages[instructionIndex]), /PRIVATE_REVIEW_INSTRUCTIONS: inspect current diff/);
		return { text: "review complete" };
	});
	await f.harness.prompt("Review my change");
	assert.equal(messageText(f.agent.state.messages.at(-1)), "review complete");
	assert.deepEqual(loadSession(f.harness.listSessions()[0]!.filePath).messages, JSON.parse(JSON.stringify(f.agent.state.messages)));
	assert.equal(projectMessages(f.agent.state.messages, () => 1).filter(item => item.kind === "user").length, 1);
});

for (const source of ["project", "user"] as const) test(`the prompt supplies the ${source} creation directory before any skills exist, then write creates a callable skill`, async t => {
	const appHome = join(tempWorkspace(t), "用户 空间");
	const f = createTestHarness(t, [], { appHome, profileId: "work" });
	const expectedDirectory = source === "project" ? join(f.root, ".anti-trace", "skills") : join(appHome, "skills");
	f.scripted.appendResponses(request => {
		assert.equal(request.context.tools?.some(tool => tool.name === "skill"), false);
		const systemPrompt = request.context.systemPrompt;
		assert.ok(systemPrompt);
		const prefix = source === "project" ? "- Project skills (default for creation): " : "- User skills (shared across projects): ";
		const location = systemPrompt.split("\n").find(line => line.startsWith(prefix));
		assert.ok(location, "The first request must disclose where to create skills, including when the skill tool is absent");
		const directory: string = JSON.parse(location.slice(prefix.length));
		assert.equal(directory, expectedDirectory.replace(/\\/g, "/"));
		assert.match(systemPrompt, /YAML frontmatter.*name and description/);
		return { toolCalls: [{ id: "create", name: "write", arguments: { path: join(directory, "generated", "SKILL.md"), content: skillText("generated", "GENERATED_SKILL_PROOF") } }] };
	}, request => {
		assert.ok(request.context.tools?.some(tool => tool.name === "skill"));
		assert.ok(request.context.systemPrompt?.includes(expectedDirectory.replace(/\\/g, "/")));
		assert.match(request.context.messages.map(messageText).join("\n"), /generated: Use generated/);
		return { toolCalls: [{ id: "use", name: "skill", arguments: { skill: "generated" } }] };
	}, request => {
		assert.ok(request.context.messages.some(message => message.role === "user" && message.isMeta && messageText(message).includes("GENERATED_SKILL_PROOF")));
		return { text: "generated and used" };
	});
	await f.harness.prompt(`Create a ${source} skill and use it`);
	assert.match(readFileSync(join(expectedDirectory, "generated", "SKILL.md"), "utf8"), /GENERATED_SKILL_PROOF/);
	assert.equal(f.harness.getSkills().skills.find(skill => skill.name === "generated")?.source, source);
	assert.equal(messageText(f.agent.state.messages.at(-1)), "generated and used");
	const other = createTestHarness(t, [], { appHome, profileId: "another" });
	assert.equal(other.harness.getSkills().skills.some(skill => skill.name === "generated"), source === "user");
});

test("manual invocation uses the same expansion and hidden skills enforce their invocation mode", async t => {
	const f = createTestHarness(t);
	writeSkill(f.root, "review", "Review $ARGUMENTS", { "disable-model-invocation": true });
	f.scripted.appendResponses(request => {
		assert.equal(request.context.tools?.some(tool => tool.name === "skill"), false);
		assert.match(request.context.messages.map(messageText).join("\n"), /Review manual scope/);
		return { text: "manual done" };
	});
	await f.harness.invokeSkill("review", "manual scope");
	assert.equal(f.scripted.requests.length, 1);
	assert.equal(f.harness.listSessions()[0]?.name, "/skill rev");
	writeSkill(f.root, "automatic", "auto", { "user-invocable": false });
	await assert.rejects(f.harness.invokeSkill("automatic"), /only be invoked by the model/);
	assert.equal(f.scripted.requests.length, 1);
});

test("unknown skills and disabled model invocation return paired errors without injecting instructions", async t => {
	const f = createTestHarness(t);
	writeSkill(f.root, "manual", "MANUAL_ONLY", { "disable-model-invocation": true });
	writeSkill(f.root, "review", "review");
	f.scripted.appendResponses({ toolCalls: [{ id: "unknown", name: "skill", arguments: { skill: "unknown" } }, { id: "manual", name: "skill", arguments: { skill: "manual" } }] }, request => {
		assertToolPairs(request.context.messages);
		assert.equal(request.context.messages.filter(message => message.role === "toolResult" && message.isError).length, 2);
		assert.equal(request.context.messages.some(message => message.role === "user" && message.metadata?.kind === "skill"), false);
		return { text: "handled" };
	});
	await f.harness.prompt("try");
});

test("catalog is not repeated, removal is announced, and new sessions start with fresh disclosure", async t => {
	const f = createTestHarness(t, [{ text: "one" }, { text: "two" }, { text: "removed" }, { text: "new" }]);
	const path = writeSkill(f.root, "review");
	await f.harness.prompt("one"); await f.harness.prompt("two");
	assert.equal(f.agent.state.messages.filter(message => message.role === "user" && message.metadata?.kind === "skill_catalog").length, 1);
	unlinkSync(path); await f.harness.prompt("removed");
	assert.equal(f.scripted.requests.at(-1)!.context.tools?.some(tool => tool.name === "skill"), false);
	assert.ok(f.agent.state.messages.some(message => message.role === "user" && message.metadata?.kind === "skill_catalog" && messageText(message).includes("(none)")));
	writeSkill(f.root);
	f.harness.newSession(); await f.harness.prompt("new");
	assert.equal(f.agent.state.messages.filter(message => message.role === "user" && message.metadata?.kind === "skill_catalog").length, 1);
});

for (const trigger of ["automatic", "overflow"] as const) test(`${trigger} compaction sends the skill catalog in the immediate continuation and persists it`, async t => {
	const f = createTestHarness(t, [{ text: "ready" }, { text: "old answer" }]);
	writeSkill(f.root, "review", "COMPACTION_SKILL_BODY");
	await f.harness.prompt("hello");
	// Put enough history after the catalog that compaction cannot retain it in the tail.
	await f.harness.prompt(HISTORY_TEXT);
	if (trigger === "automatic") f.harness.setContextWindow(40000);
	else f.scripted.appendResponses({ error: "maximum context length exceeded" });
	f.scripted.appendResponses({ text: "<summary>Prior work is complete.</summary>" }, request => {
		assert.match(messageText(request.context.messages[0]), /Summary:\nPrior work is complete/);
		const catalogs = request.context.messages.filter(message => message.role === "user" && message.metadata?.kind === "skill_catalog");
		assert.equal(catalogs.length, 1, "The first post-compaction request must contain an explicit skill catalog");
		assert.match(messageText(catalogs[0]), /review: Use review/);
		assert.ok(request.context.tools?.some(tool => tool.name === "skill"));
		assertToolPairs(request.context.messages);
		return { toolCalls: [{ id: "after-compact", name: "skill", arguments: { skill: "review" } }] };
	}, request => {
		assertToolPairs(request.context.messages);
		assert.equal(request.context.messages.filter(message => message.role === "user" && message.metadata?.kind === "skill_catalog").length, 1);
		assert.ok(request.context.messages.some(message => message.role === "user" && message.isMeta && messageText(message).includes("COMPACTION_SKILL_BODY")));
		return { text: "continued with the skill" };
	});
	await f.harness.prompt("Review the current change");
	const last = f.agent.state.messages.at(-1);
	assert.ok(last?.role === "assistant");
	assert.equal(last.stopReason, "stop", last.errorMessage);
	assert.equal(f.events.filter(event => event.type === "compaction_end").length, 1);
	assert.equal(f.scripted.requests.length, trigger === "automatic" ? 5 : 6);
	assert.equal(f.scripted.pendingResponses, 0);
	assert.deepEqual(loadSession(f.harness.listSessions()[0]!.filePath).messages, f.agent.state.messages);
});

test("ordinary file tools can create and read the skill package without a creator tool", async t => {
	const f = createTestHarness(t), write = createWriteTool(f.root), read = createReadTool(f.root);
	await write.execute("create", { path: ".anti-trace/skills/review/SKILL.md", content: skillText("review", "FILE_TOOL_SKILL_BODY") });
	const result = await read.execute("read", { path: ".anti-trace/skills/review/SKILL.md" });
	assert.match(result.content.filter(block => block.type === "text").map(block => block.text).join("\n"), /FILE_TOOL_SKILL_BODY/);
	assert.equal(f.harness.reloadSkills().skills[0]?.name, "review");
});

test("resume and repeated compaction preserve invoked instructions without re-granting permissions", async t => {
	const f = createTestHarness(t, [{ text: "first" }, { text: "<summary>compact one</summary>" }, { text: "continue" }, { text: "<summary>compact two</summary>" }]);
	const path = writeSkill(f.root, "review", "DURABLE_INSTRUCTIONS $ARGUMENTS", { "allowed-tools": ["read"] });
	await f.harness.invokeSkill("review", "original args");
	f.harness.newSession(); assert.equal(f.harness.resumeAt(1), true);
	assert.deepEqual(f.harness.getActiveSkillTools(), []);
	// Keep the original rendered snapshot even if its definition changes on disk.
	writeFileSync(path, skillText("review", "CHANGED_DEFINITION"));
	for (let index = 0; index < 5; index++) f.agent.state.messages.push({ role: "user", content: [{ type: "text", text: "old history ".repeat(10000) }], timestamp: index });
	assert.equal(await f.harness.compact(), true);
	assert.ok(f.agent.state.messages.some(message => message.role === "user" && message.isMeta && messageText(message).includes("DURABLE_INSTRUCTIONS original args")));
	assert.deepEqual(loadSession(f.harness.listSessions()[0]!.filePath).messages, f.agent.state.messages);
	f.harness.newSession(); assert.equal(f.harness.resumeAt(1), true);
	await f.harness.prompt("continue");
	for (let index = 0; index < 5; index++) f.agent.state.messages.push({ role: "user", content: [{ type: "text", text: "more history ".repeat(10000) }], timestamp: index });
	assert.equal(await f.harness.compact(), true);
	assert.ok(f.agent.state.messages.some(message => message.role === "user" && message.isMeta && messageText(message).includes("DURABLE_INSTRUCTIONS original args")));
});

test("skill discovery is available without model configuration; failed execution has no transcript effects", async t => {
	const f = createTestHarness(t, [], { unconfigured: true }); writeSkill(f.root);
	assert.equal(f.harness.reloadSkills().skills.length, 1);
	await assert.rejects(f.harness.invokeSkill("review"), /模型/);
	assert.deepEqual(f.agent.state.messages, []);
	f.harness.newSession(); assert.equal(f.harness.getSkills().skills.length, 1);
});

test("skill refresh preserves an embedder's custom system prompt", async t => {
	const f = createTestHarness(t, [{ text: "custom" }]); writeSkill(f.root);
	f.agent.state.systemPrompt = "CUSTOM_SYSTEM_INSTRUCTIONS";
	await f.harness.prompt("task");
	assert.equal(f.scripted.requests[0]?.context.systemPrompt, "CUSTOM_SYSTEM_INSTRUCTIONS");
	assert.ok(f.scripted.requests[0]?.context.tools?.some(tool => tool.name === "skill"));
});
