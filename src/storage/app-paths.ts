import { createHash } from "node:crypto";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface StorageOptions { appHome?: string; profileId?: string }
export interface AppPaths {
	appRoot: string;
	profileId: string;
	profileRoot: string;
	configsDir: string;
	userSkillsDir: string;
	preferencesFile: string;
	defaultSelectionFile: string;
	projectId: string;
	cwd: string;
	projectRoot: string;
	projectInfoFile: string;
	projectSelectionFile: string;
	sessionsDir: string;
	toolResultsDir: string;
}

/** Resolve existing aliases, including macOS /var and Windows junctions, before assigning an identity. */
export function canonicalWorkspace(cwd: string): string {
	const absolute = resolve(cwd);
	try { return realpathSync.native(absolute); }
	catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; return absolute; }
}

export function projectIdForCwd(cwd: string): string {
	return createHash("sha256").update(canonicalWorkspace(cwd)).digest("hex");
}

/** Pure path calculation: reading preferences or constructing a tool must not create directories. */
export function getAppPaths(options: StorageOptions & { cwd: string }): AppPaths {
	const profileId = options.profileId ?? "local";
	if (!/^[a-z0-9][a-z0-9_-]{0,127}$/.test(profileId) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/.test(profileId)) {
		throw new Error("Invalid storage profile ID");
	}
	const home = options.appHome ?? process.env.ANTI_TRACE_HOME ?? join(homedir(), ".anti-trace");
	if (!home.trim()) throw new Error("ANTI_TRACE_HOME must not be empty");
	const appRoot = resolve(home), cwd = canonicalWorkspace(options.cwd);
	const profileRoot = join(appRoot, "profiles", profileId), projectId = projectIdForCwd(cwd);
	const projectRoot = join(profileRoot, "projects", projectId);
	return {
		appRoot, profileId, profileRoot, cwd, projectId, projectRoot,
		configsDir: join(profileRoot, "configs"), userSkillsDir: join(appRoot, "skills"), preferencesFile: join(appRoot, "preferences.json"),
		defaultSelectionFile: join(profileRoot, "default-model.json"),
		projectInfoFile: join(projectRoot, "project.json"), projectSelectionFile: join(projectRoot, "last-model.json"),
		sessionsDir: join(projectRoot, "sessions"), toolResultsDir: join(projectRoot, "tool-results"),
	};
}

/** Metadata is created only when project data is actually persisted. Never rewrite existing records. */
export function ensureProjectDirectory(paths: AppPaths): void {
	mkdirSync(paths.projectRoot, { recursive: true, mode: 0o700 });
	try { writeFileSync(paths.projectInfoFile, JSON.stringify({ version: 1, cwd: paths.cwd }, null, 2) + "\n", { flag: "wx", mode: 0o600 }); }
	catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
}
