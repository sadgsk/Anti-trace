import type { AgentTool } from "../types.ts";
import type { AcquiredToolSource, ToolSource, ToolSourceContext } from "../harness/tool-source.ts";
import { failedResult, normalizeMcpResult, resultDetails } from "./content.ts";
import { mcpToolName } from "./tool-names.ts";
import { verifyToolSchema } from "./tool-schema.ts";
import type { JsonObject, McpToolDefinition } from "./types.ts";
import { digest, safeText, throwCancelled } from "./util.ts";

/** Each source and each tool call can be cancelled independently of the shared connection. */
export function sourceLifetime(parent?: AbortSignal) {
	throwCancelled(parent);
	const controller = new AbortController();
	return {
		release: () => controller.abort(),
		callSignal: (signal?: AbortSignal) => AbortSignal.any([controller.signal, ...(parent ? [parent] : []), ...(signal ? [signal] : [])]),
	};
}

export class McpToolSource implements ToolSource {
	acquire(context: ToolSourceContext, signal?: AbortSignal): AcquiredToolSource {
		const { binding, model, outputDirectory, reservedNames } = context;
		const life = sourceLifetime(signal);
		const tools: AgentTool[] = [], diagnostics: string[] = [], instructions: string[] = [];
		const candidates = new Map<string, { serverId: string; definition: McpToolDefinition }[]>();
		let instructionBudget = 8192;
		for (const serverId of [...binding.servers.keys()].sort()) {
			const server = binding.servers.get(serverId)!;
			if (server.instructions && instructionBudget > 0) {
				const text = safeText(server.instructions).slice(0, Math.min(2048, instructionBudget));
				instructions.push(JSON.stringify({ server: serverId, instructions: text }));
				instructionBudget -= text.length;
			}
			for (const definition of server.tools) {
				const name = mcpToolName(serverId, definition.name);
				const group = candidates.get(name) ?? [];
				group.push({ serverId, definition });
				candidates.set(name, group);
			}
		}
		for (const name of [...candidates.keys()].sort()) {
			const candidatesForName = candidates.get(name)!;
			if (reservedNames.has(name) || candidatesForName.length !== 1) {
				diagnostics.push("MCP 工具名称冲突: " + name);
				continue;
			}
			const { serverId, definition } = candidatesForName[0]!;
			if (definition.execution?.taskSupport === "required") {
				diagnostics.push(name + ": 工具要求 MCP task 扩展。");
				continue;
			}
			try { verifyToolSchema(definition.inputSchema); }
			catch (error) {
				diagnostics.push(name + ": " + safeText(error instanceof Error ? error.message : "schema 无效。").slice(0, 256));
				continue;
			}
			const server = binding.servers.get(serverId)!;
			const identity = { provider: "mcp" as const, scopeKey: server.identity, actionKey: digest(["tool", definition]),
				label: safeText(serverId + " / " + definition.name) + (definition.annotations?.readOnlyHint === true ? " (server hint: read-only)" : "") };
			tools.push({
				name, label: identity.label, parameters: definition.inputSchema,
				description: safeText(definition.description ?? definition.title ?? identity.label),
				resolvePermission: () => identity,
				async execute(_callId, args, signal, onUpdate) {
					const started = Date.now(), callSignal = life.callSignal(signal);
					try {
						throwCancelled(callSignal);
						const response = await binding.callTool(serverId, definition.name, args as JsonObject, {
							signal: callSignal,
							onProgress: onUpdate && (progress => onUpdate({ content: [], details: { ...resultDetails(serverId, definition.name, started), status: "running", progress } })),
						});
						return await normalizeMcpResult(server, definition.name, response, { signal: callSignal, outputDirectory, images: model.capabilities?.images }, started);
					} catch (error) { return failedResult(serverId, definition.name, started, error); }
				},
			});
		}
		return { tools, instructions, diagnostics, release: life.release };
	}
}
