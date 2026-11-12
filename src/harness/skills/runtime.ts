import { createHash } from "node:crypto";
import type { AgentMessage, UserMessage } from "../../types.ts";
import { SkillRegistry } from "./registry.ts";

export function splitSkillArguments(input: string): string[] {
	const result: string[] = [];
	let current = "", quote = "", started = false;
	for (let i = 0; i < input.length; i++) {
		const char = input[i]!;
		if (char === "\\" && (input[i + 1] === quote || input[i + 1] === "\\") && quote === '"') { current += input[++i]; started = true; }
		else if (quote) { if (char === quote) quote = ""; else current += char; }
		else if ((char === '"' || char === "'") && !started) { quote = char; started = true; }
		else if (/\s/u.test(char)) { if (started) { result.push(current); current = ""; started = false; } }
		else { current += char; started = true; }
	}
	if (quote) throw new Error("Skill arguments contain an unclosed quote");
	if (started) result.push(current);
	return result;
}

/** Definitions, model disclosure and per-session invocation snapshots have separate lifetimes. */
export class SkillRuntime {
	private readonly invoked = new Map<string, UserMessage>();
	private readonly grants = new Set<string>();
	constructor(readonly registry: SkillRegistry) {}
	beginTurn(): void { this.grants.clear(); }
	reset(): void { this.invoked.clear(); this.grants.clear(); }
	getAllowedTools(): readonly string[] { return [...this.grants]; }
	getPermissionTools(name: string): readonly string[] | undefined { return this.registry.find(name)?.allowedTools; }

	prepare(name: string, args: string, invoker: "user" | "model", sessionId: string, availableTools: readonly string[]): UserMessage {
		const skill = this.registry.find(name);
		if (!skill) throw new Error(`Unknown skill: ${name}`);
		if (invoker === "model" && skill.disableModelInvocation) throw new Error(`Skill ${name} does not allow model invocation`);
		if (invoker === "user" && !skill.userInvocable) throw new Error(`Skill ${name} can only be invoked by the model`);
		for (const tool of skill.allowedTools) if (!availableTools.includes(tool)) throw new Error(`Skill ${name} requires unavailable tool: ${tool}`);
		let positional: string[] | undefined;
		const positions = () => positional ??= splitSkillArguments(args);
		let consumed = false;
		const names = new Set(skill.argumentNames);
		const body = skill.body.replace(/\\?\$(?:\{(CLAUDE_SKILL_DIR|CLAUDE_SESSION_ID)\}|ARGUMENTS(?:\[(\d+)\])?|(\d+)|([a-zA-Z_][\w-]*))/gu,
			(token, variable: string | undefined, bracketIndex: string | undefined, index: string | undefined, named: string | undefined) => {
				if (token.startsWith("\\")) return token.slice(1);
				if (variable) return variable === "CLAUDE_SKILL_DIR" ? skill.directory.replace(/\\/g, "/") : sessionId;
				if (named) { if (!names.has(named)) return token; consumed = true; return positions()[skill.argumentNames.indexOf(named)] ?? ""; }
				if (bracketIndex !== undefined || index !== undefined) {
					const value = positions()[Number(bracketIndex ?? index)];
					if (value === undefined) return token;
					consumed = true; return value;
				}
				consumed = true; return args;
			});
		const content = `Skill: ${skill.name}\nBase directory for this skill: ${skill.directory}\nResolve relative resource paths against this directory.\n\n${body}${args && !consumed ? `\n\nARGUMENTS: ${args}` : ""}`;
		return { role: "user", isMeta: true, timestamp: Date.now(), content: [{ type: "text", text: content }],
			metadata: { kind: "skill", name: skill.name, path: skill.path, source: skill.source, args, allowedTools: [...skill.allowedTools] } };
	}

	/** Only committed instruction messages grant tools; restored history never re-grants permissions. */
	accept(message: AgentMessage, grant = true): void {
		if (message.role !== "user" || !message.isMeta || message.metadata?.kind !== "skill" || typeof message.metadata.name !== "string") return;
		this.invoked.set(message.metadata.name, structuredClone(message));
		if (grant && Array.isArray(message.metadata.allowedTools)) for (const tool of message.metadata.allowedTools) if (typeof tool === "string") this.grants.add(tool);
	}
	restore(messages: readonly AgentMessage[]): void { this.reset(); for (const message of messages) this.accept(message, false); }

	catalog(messages: readonly AgentMessage[], contextWindow: number): UserMessage | undefined {
		const skills = this.registry.modelSkills();
		const entries = skills.map(skill => ({ name: skill.name, description: skill.description.slice(0, 250) }));
		const version = createHash("sha256").update(JSON.stringify(entries)).digest("hex");
		const previous = [...messages].reverse().find(message => message.role === "user" && message.isMeta && message.metadata?.kind === "skill_catalog");
		if (previous?.role === "user" && previous.metadata?.version === version) return;
		if (!entries.length && !previous) return;
		const budget = Math.max(500, Math.floor(contextWindow * 0.04));
		const nameCost = entries.reduce((total, entry) => total + entry.name.length + 4, 0);
		const descriptionLimit = Math.max(0, Math.min(250, Math.floor((budget - nameCost) / Math.max(1, entries.length))));
		const listing = entries.map(entry => `- ${entry.name}${descriptionLimit ? `: ${entry.description.slice(0, descriptionLimit)}` : ""}`).join("\n");
		return { role: "user", isMeta: true, timestamp: Date.now(), metadata: { kind: "skill_catalog", version },
			content: [{ type: "text", text: `Available skills for the skill tool (this list replaces earlier skill catalogs):\n${listing || "(none)"}\nLoad a matching skill before doing its task. Only the selected skill's instructions are loaded on invocation.` }] };
	}

	retainedMessages(kept: readonly AgentMessage[], tokenBudget: number): UserMessage[] {
		const present = new Set(kept.filter(message => message.role === "user" && message.metadata?.kind === "skill")
			.map(message => message.role === "user" ? `${message.metadata?.name}:${message.timestamp}` : ""));
		const result: UserMessage[] = [];
		let remaining = Math.max(0, Math.floor(tokenBudget * 4));
		for (const message of [...this.invoked.values()].sort((a, b) => b.timestamp - a.timestamp)) {
			if (present.has(`${message.metadata?.name}:${message.timestamp}`)) continue;
			if (remaining < 200) break;
			const original = message.content.filter(block => block.type === "text").map(block => block.text).join("\n");
			const limit = Math.min(20_000, remaining);
			const text = original.length <= limit ? original : `${original.slice(0, limit - 65)}\n[Skill instructions truncated to fit the context budget.]`;
			result.push({ ...structuredClone(message), content: [{ type: "text", text }] });
			remaining -= text.length;
		}
		return result;
	}
}
