export interface SkillDefinition {
	name: string;
	description: string;
	path: string;
	directory: string;
	source: "project" | "user";
	body: string;
	argumentHint?: string;
	argumentNames: string[];
	userInvocable: boolean;
	disableModelInvocation: boolean;
	allowedTools: string[];
}

export interface SkillDiagnostic { path: string; message: string }
export interface SkillSnapshot { skills: readonly SkillDefinition[]; diagnostics: readonly SkillDiagnostic[] }
export interface SkillDirectory { path: string; source: SkillDefinition["source"] }
