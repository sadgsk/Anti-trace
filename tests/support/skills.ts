import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function skillText(name = "review", body = "PRIVATE_REVIEW_INSTRUCTIONS: inspect the change.", fields: Record<string, unknown> = {}): string {
	return `---\n${Object.entries({ name, description: `Use ${name} for its specialized task.`, ...fields }).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join("\n")}\n---\n${body}\n`;
}

export function writeSkill(root: string, name = "review", body?: string, fields?: Record<string, unknown>, directory = join(root, ".anti-trace", "skills")): string {
	const path = join(directory, name, "SKILL.md");
	mkdirSync(join(directory, name), { recursive: true });
	writeFileSync(path, skillText(name, body, fields));
	return path;
}
