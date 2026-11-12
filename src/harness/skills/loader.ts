import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseDocument } from "yaml";
import type { SkillDefinition, SkillDiagnostic, SkillDirectory, SkillSnapshot } from "./types.ts";

const MAX_SKILL_BYTES = 256 * 1024;
const TOOL_NAMES: Record<string, string> = { read: "read", edit: "edit", write: "write", bash: "bash", powershell: "powershell" };

/** Project discovery and creation share the current working directory. */
export function skillDirectories(cwd: string, userSkillsDir: string): SkillDirectory[] {
	return [
		{ path: join(resolve(cwd), ".anti-trace", "skills"), source: "project" },
		{ path: resolve(userSkillsDir), source: "user" },
	];
}

function booleanField(value: unknown, fallback: boolean, name: string): boolean {
	if (value === undefined) return fallback;
	if (typeof value === "boolean") return value;
	if (typeof value === "string" && /^(true|false)$/i.test(value)) return value.toLowerCase() === "true";
	throw new Error(`${name} must be a boolean`);
}

export function parseSkill(text: string, path: string, source: SkillDefinition["source"], folderName: string): SkillDefinition {
	const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(text.replace(/^\uFEFF/u, ""));
	if (!match) throw new Error("SKILL.md must start with YAML frontmatter between --- lines");
	const document = parseDocument(match[1]!, { uniqueKeys: true });
	if (document.errors.length) throw new Error(document.errors[0]!.message.split("\n")[0]);
	const fields: unknown = document.toJS({ maxAliasCount: 50 });
	if (!fields || typeof fields !== "object" || Array.isArray(fields)) throw new Error("Skill frontmatter must be a mapping");
	const data = fields as Record<string, unknown>;
	const name = data.name;
	if (typeof name !== "string" || name.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(name)) throw new Error("name must contain 1–64 lowercase letters, numbers or single hyphens");
	if (name !== folderName) throw new Error("name must match the skill directory name");
	if (typeof data.description !== "string" || !data.description.trim() || data.description.length > 1024) throw new Error("description must contain 1–1024 characters");
	const normalized = text.replace(/^\uFEFF/u, "");
	const body = normalized.slice(match[0].length).trim();
	if (!body) throw new Error("Skill instructions must not be empty");
	for (const key of ["hooks", "paths", "shell", "effort", "background", "disallowed-tools"]) {
		if (data[key] !== undefined) throw new Error(`${key} is not supported by this runtime`);
	}
	if (data.context !== undefined && data.context !== "inline") throw new Error("Only inline skill execution is supported; fork requires a subagent runtime");
	if (data.agent !== undefined || (data.model !== undefined && data.model !== "inherit")) throw new Error("Skill-specific agents and models are not supported");
	if (/!`[^`]+`|^```!/mu.test(body)) throw new Error("Inline shell injection is not supported; instruct the agent to use its shell tool instead");
	const stringList = (value: unknown, field: string): string[] => {
		if (value === undefined) return [];
		if (typeof value === "string") return value.split(/[\s,]+/u).filter(Boolean);
		if (Array.isArray(value) && value.every(item => typeof item === "string")) return value;
		throw new Error(`${field} must be a string or list of strings`);
	};
	const allowedTools = stringList(data["allowed-tools"], "allowed-tools").map(tool => {
		const canonical = TOOL_NAMES[tool.toLowerCase()];
		if (!canonical) throw new Error(`Unsupported allowed-tools entry: ${tool}; use plain tool names`);
		return canonical;
	});
	const argumentNames = stringList(data.arguments, "arguments");
	if (argumentNames.some(arg => !/^[a-zA-Z_][\w-]*$/u.test(arg)) || new Set(argumentNames).size !== argumentNames.length) throw new Error("arguments must contain unique parameter names");
	if (data["argument-hint"] !== undefined && typeof data["argument-hint"] !== "string") throw new Error("argument-hint must be a string");
	return { name, description: data.description.trim(), path, directory: dirname(path), source, body, argumentNames,
		argumentHint: data["argument-hint"] as string | undefined, allowedTools: [...new Set(allowedTools)],
		userInvocable: booleanField(data["user-invocable"], true, "user-invocable"),
		disableModelInvocation: booleanField(data["disable-model-invocation"], false, "disable-model-invocation") };
}

/** Cache parsed files, but rescan directory entries so files created by write/shell are discovered. */
export class SkillLoader {
	private readonly cache = new Map<string, { signature: string; skill?: SkillDefinition; error?: string }>();
	load(directories: readonly SkillDirectory[]): SkillSnapshot {
		const skills: SkillDefinition[] = [], diagnostics: SkillDiagnostic[] = [], names = new Set<string>(), files = new Set<string>(), visited = new Set<string>();
		for (const directory of directories) {
			let entries;
			try { entries = readdirSync(directory.path, { withFileTypes: true }); }
			catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") diagnostics.push({ path: directory.path, message: error instanceof Error ? error.message : String(error) });
				continue;
			}
			for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name)).slice(0, 2000)) {
				if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
				const path = join(directory.path, entry.name, "SKILL.md");
				visited.add(path);
				try {
					const stat = statSync(path);
					if (!stat.isFile() || stat.size > MAX_SKILL_BYTES) throw new Error("SKILL.md must be a regular file no larger than 256 KiB");
					const identity = realpathSync(path);
					if (files.has(identity)) continue;
					files.add(identity);
					const signature = `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}:${directory.source}`;
					let cached = this.cache.get(path);
					if (cached?.signature !== signature) {
						try { cached = { signature, skill: parseSkill(readFileSync(path, "utf8"), path, directory.source, entry.name) }; }
						catch (error) { cached = { signature, error: error instanceof Error ? error.message : String(error) }; }
						this.cache.set(path, cached);
					}
					if (cached.error) { diagnostics.push({ path, message: cached.error }); continue; }
					const skill = cached.skill!;
					if (names.has(skill.name)) { diagnostics.push({ path, message: `Skill ${skill.name} is shadowed by a higher-priority definition` }); continue; }
					names.add(skill.name); skills.push(skill);
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") diagnostics.push({ path, message: error instanceof Error ? error.message : String(error) });
				}
			}
			if (entries.length > 2000) diagnostics.push({ path: directory.path, message: "Skill discovery limited to 2000 entries per directory" });
		}
		for (const path of this.cache.keys()) if (!visited.has(path)) this.cache.delete(path);
		return { skills, diagnostics };
	}
}
