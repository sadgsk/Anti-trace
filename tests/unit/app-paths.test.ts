import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { ensureProjectDirectory, getAppPaths, projectIdForCwd } from "../../src/storage/app-paths.ts";
import { tempWorkspace } from "../support/fixtures.ts";

test("paths are stable, lazy, share user configuration and separate projects and profiles", t => {
	const cwd = tempWorkspace(t), appHome = join(cwd, "data");
	const a = getAppPaths({ cwd, appHome }), b = getAppPaths({ cwd: join(cwd, "other"), appHome });
	assert.deepEqual(getAppPaths({ cwd: join(cwd, "."), appHome }), a);
	assert.equal(a.configsDir, b.configsDir); assert.equal(a.preferencesFile, b.preferencesFile);
	assert.notEqual(a.sessionsDir, b.sessionsDir); assert.notEqual(a.projectSelectionFile, b.projectSelectionFile);
	const other = getAppPaths({ cwd, appHome, profileId: "user-a" });
	assert.notEqual(a.configsDir, other.configsDir); assert.notEqual(a.sessionsDir, other.sessionsDir);
	assert.notEqual(a.defaultSelectionFile, other.defaultSelectionFile);
	assert.equal(a.preferencesFile, other.preferencesFile);
	assert.equal(existsSync(appHome), false);
	ensureProjectDirectory(a);
	assert.deepEqual(JSON.parse(readFileSync(a.projectInfoFile, "utf8")), { version: 1, cwd: a.cwd });
});

test("explicit appHome wins over the environment and environment roots are evaluated per call", t => {
	const cwd = tempWorkspace(t), original = process.env.ANTI_TRACE_HOME;
	try {
		process.env.ANTI_TRACE_HOME = join(cwd, "environment");
		assert.equal(getAppPaths({ cwd }).appRoot, resolve(cwd, "environment"));
		assert.equal(getAppPaths({ cwd, appHome: join(cwd, "explicit") }).appRoot, resolve(cwd, "explicit"));
		process.env.ANTI_TRACE_HOME = " "; assert.throws(() => getAppPaths({ cwd }), /empty/);
	} finally { process.env.ANTI_TRACE_HOME = original; }
});

test("directory aliases share an identity and formerly ambiguous path names remain distinct", t => {
	const root = tempWorkspace(t), target = join(root, "target"), alias = join(root, "alias");
	mkdirSync(target); symlinkSync(target, alias, process.platform === "win32" ? "junction" : "dir");
	assert.equal(projectIdForCwd(target), projectIdForCwd(alias));
	assert.notEqual(projectIdForCwd(join(root, "a-b", "c")), projectIdForCwd(join(root, "a", "b-c")));
});

test("profile IDs cannot escape the root or use incompatible Windows names", t => {
	const cwd = tempWorkspace(t);
	for (const profileId of ["", ".", "..", "../escape", "a/b", "a\\b", "C:\\escape", "User", "con", "nul", "lpt1", "a.b"]) {
		assert.throws(() => getAppPaths({ cwd, profileId }), /profile ID/, profileId);
	}
});
