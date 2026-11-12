import { SkillLoader } from "./loader.ts";
import type { SkillDefinition, SkillDirectory, SkillSnapshot } from "./types.ts";

export class SkillRegistry {
	private readonly loader = new SkillLoader();
	private snapshot: SkillSnapshot = { skills: [], diagnostics: [] };
	constructor(private readonly directories: readonly SkillDirectory[]) { this.reload(); }
	reload(): SkillSnapshot { this.snapshot = this.loader.load(this.directories); return this.getSnapshot(); }
	getSnapshot(): SkillSnapshot { return structuredClone(this.snapshot); }
	find(name: string): SkillDefinition | undefined { return this.snapshot.skills.find(skill => skill.name === name); }
	modelSkills(): readonly SkillDefinition[] { return this.snapshot.skills.filter(skill => !skill.disableModelInvocation); }
}
