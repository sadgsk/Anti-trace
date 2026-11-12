import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SkillLoader, parseSkill, skillDirectories } from "../../src/harness/skills/loader.ts";
import { SkillRegistry } from "../../src/harness/skills/registry.ts";
import { SkillRuntime, splitSkillArguments } from "../../src/harness/skills/runtime.ts";
import { tempWorkspace } from "../support/fixtures.ts";
import { skillText, writeSkill } from "../support/skills.ts";

test("project skills override user definitions, diagnostics isolate bad files, and rescans discover changes", t => {
	const root = tempWorkspace(t), user = join(root, "user"), project = join(root, ".anti-trace", "skills");
	writeSkill(root, "review", "USER", {}, user);
	const path = writeSkill(root, "review", "PROJECT");
	writeSkill(root, "bad", "bad", { name: "other" });
	const registry = new SkillRegistry([{ path: project, source: "project" }, { path: user, source: "user" }]);
	assert.equal(registry.find("review")?.body, "PROJECT");
	assert.equal(registry.getSnapshot().diagnostics.length, 2);
	writeFileSync(path, skillText("review", "UPDATED_INSTRUCTIONS"));
	writeSkill(root, "new-skill", "NEW");
	registry.reload();
	assert.equal(registry.find("review")?.body, "UPDATED_INSTRUCTIONS");
	assert.ok(registry.find("new-skill"));
	unlinkSync(path); registry.reload();
	assert.equal(registry.find("review")?.body, "USER");
	assert.deepEqual(new SkillLoader().load([{ path: join(root, "missing"), source: "user" }]), { skills: [], diagnostics: [] });
});

test("discovery uses only cwd project skills and user skills, including inside nested Git directories", t => {
	const root = tempWorkspace(t), nested = join(root, "a", "b"), user = join(root, "user");
	mkdirSync(nested, { recursive: true });
	const expected = [{ path: join(nested, ".anti-trace", "skills"), source: "project" }, { path: user, source: "user" }];
	assert.deepEqual(skillDirectories(nested, user), expected);
	mkdirSync(join(root, ".git"));
	writeSkill(root, "parent-only"); writeSkill(nested, "local-only"); writeSkill(root, "shared", "USER", {}, user);
	assert.deepEqual(skillDirectories(nested, user), expected);
	const registry = new SkillRegistry(skillDirectories(nested, user));
	assert.equal(registry.find("parent-only"), undefined);
	assert.equal(registry.find("local-only")?.source, "project");
	assert.equal(registry.find("shared")?.source, "user");
});

test("frontmatter supports Unicode, CRLF, BOM and aliases for tool names", () => {
	const skill = parseSkill("\uFEFF" + skillText("review", "中文说明", { "allowed-tools": ["Read", "PowerShell"], "user-invocable": false }).replace(/\n/g, "\r\n"), "/review/SKILL.md", "project", "review");
	assert.equal(skill.body, "中文说明");
	assert.deepEqual(skill.allowedTools, ["read", "powershell"]);
	assert.equal(skill.userInvocable, false);
});

for (const [label, text] of [
	["missing frontmatter", "instructions"], ["invalid YAML", "---\nname: [\n---\nbody"],
	["duplicate YAML keys", "---\nname: review\nname: other\ndescription: text\n---\nbody"],
	["missing description", skillText("review", "body", { description: "" })],
	["invalid name", skillText("Review")], ["unsupported fork", skillText("review", "body", { context: "fork" })],
	["unsupported permission patterns", skillText("review", "body", { "allowed-tools": "Bash(git:*)" })],
	["inline command", skillText("review", "Current diff: !`git diff`")],
	["invalid boolean", skillText("review", "body", { "user-invocable": "maybe" })],
] as const) test(`invalid skill reports ${label}`, () => {
	assert.throws(() => parseSkill(text, "/review/SKILL.md", "project", "review"));
});

test("arguments expand once, preserve Windows paths and support quoting and named parameters", t => {
	const root = tempWorkspace(t), path = writeSkill(root, "review", "$ARGUMENTS | $0 | $ARGUMENTS[1] | $target | \\$0 | ${CLAUDE_SKILL_DIR} | ${CLAUDE_SESSION_ID}", { arguments: ["target"] });
	const runtime = new SkillRuntime(new SkillRegistry([{ path: join(root, ".anti-trace", "skills"), source: "project" }]));
	const result = runtime.prepare("review", '"C:\\a folder" "$ARGUMENTS"', "model", "session-123", ["read"]);
	const body = result.content[0]; assert.equal(body.type, "text");
	if (body.type === "text") {
		assert.ok(body.text.includes('C:\\a folder | $ARGUMENTS | C:\\a folder | $0'));
		assert.ok(body.text.includes("session-123"));
		assert.ok(body.text.includes(path.replace(/\\/g, "/").replace(/\/SKILL.md$/, "")));
	}
	assert.deepEqual(splitSkillArguments("'two words' plain \"\""), ["two words", "plain", ""]);
	assert.deepEqual(splitSkillArguments("John's branch"), ["John's", "branch"]);
	assert.throws(() => splitSkillArguments('"broken'));
});

test("raw arguments remain ordinary prose, and catalog budgets preserve all skill names", t => {
	const root = tempWorkspace(t);
	writeSkill(root, "review", "$ARGUMENTS");
	writeSkill(root, "another", "instructions", { description: "long ".repeat(180) });
	const runtime = new SkillRuntime(new SkillRegistry([{ path: join(root, ".anti-trace", "skills"), source: "project" }]));
	const message = runtime.prepare("review", "'Please don't rewrite this", "model", "s", []);
	assert.ok(message.content.some(block => block.type === "text" && block.text.includes("'Please don't rewrite this")));
	const catalog = runtime.catalog([], 1000)!;
	const text = catalog.content.filter(block => block.type === "text").map(block => block.text).join("\n");
	assert.match(text, /- another/); assert.match(text, /- review/);
	assert.equal(runtime.catalog([catalog], 1000), undefined);
	runtime.accept(message); assert.equal(runtime.retainedMessages([], 0).length, 0);
});

test("manual and model visibility are separate and context restoration does not restore grants", t => {
	const root = tempWorkspace(t);
	writeSkill(root, "manual", "$ARGUMENTS", { "disable-model-invocation": true });
	writeSkill(root, "automatic", "read", { "user-invocable": false, "allowed-tools": ["read"] });
	const runtime = new SkillRuntime(new SkillRegistry([{ path: join(root, ".anti-trace", "skills"), source: "project" }]));
	assert.throws(() => runtime.prepare("manual", "", "model", "s", ["read"]));
	assert.throws(() => runtime.prepare("automatic", "", "user", "s", ["read"]));
	assert.throws(() => runtime.prepare("missing", "", "model", "s", ["read"]));
	assert.throws(() => runtime.prepare("automatic", "", "model", "s", []));
	const message = runtime.prepare("automatic", "", "model", "s", ["read"]);
	runtime.accept(message); assert.deepEqual(runtime.getAllowedTools(), ["read"]);
	runtime.restore([message]); assert.deepEqual(runtime.getAllowedTools(), []);
	assert.equal(runtime.retainedMessages([], 1000).length, 1);
	assert.equal(runtime.retainedMessages([message], 1000).length, 0);
	runtime.reset(); assert.equal(runtime.retainedMessages([], 1000).length, 0);
});
