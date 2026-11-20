import type { AgentTool, AgentToolResult } from "../types.ts";
import type { AcquiredToolSource, ToolSource, ToolSourceContext } from "../harness/tool-source.ts";
import { failedResult, normalizeMcpResult, toDraft, type McpContentOptions, type McpDraftMaterial, type McpResultDetails } from "./content.ts";
import { sourceLifetime } from "./tool-source.ts";
import { McpError, type JsonValue, type McpBinding } from "./types.ts";
import { digest, safeText, throwCancelled } from "./util.ts";

const absoluteResourceUri = /^[a-zA-Z][a-zA-Z0-9+.-]*:[^\s]*$/u;

function resourceServer(binding: McpBinding, id: string) {
	const server = binding.servers.get(id);
	if (!server?.capabilities.resources) throw new McpError("unsupported", "该 MCP 服务器没有可用的资源能力。");
	return server;
}

async function readResource(binding: McpBinding, id: string, uri: string, options: McpContentOptions) {
	const started = Date.now(), server = resourceServer(binding, id);
	if (!absoluteResourceUri.test(uri)) throw new McpError("config", "请输入完整的资源 URI。");
	const result = await binding.readResource(id, uri, { signal: options.signal });
	return normalizeMcpResult(server, "resources/read", { content: result.contents.map(resource => ({ type: "resource", resource })) }, options, started);
}

export async function readMcpResource(binding: McpBinding, id: string, uri: string, options: McpContentOptions): Promise<McpDraftMaterial> {
	const result = await readResource(binding, id, uri, options);
	return toDraft(result, `[MCP ${id} · ${uri} · ${new Date().toISOString()}]`, options, resourceServer(binding, id).outputMaxBytes);
}

async function listResources(binding: McpBinding, id: string, options: McpContentOptions): Promise<AgentToolResult<McpResultDetails>> {
	const started = Date.now(), server = resourceServer(binding, id);
	const [resources, templates] = await Promise.allSettled([binding.listResources(id, { signal: options.signal }), binding.listResourceTemplates(id, { signal: options.signal })]);
	throwCancelled(options.signal);
	if (resources.status === "rejected" && templates.status === "rejected") throw resources.reason;
	const catalog: Record<string, JsonValue> = { server: id };
	// Copy only public directory fields. Preserve a failed directory as an error distinct from an empty list.
	if (resources.status === "fulfilled") catalog.resources = resources.value.map(({ uri, name, mimeType, description, title }) =>
		({ uri, name, ...mimeType && { mimeType }, ...description && { description }, ...title && { title } }));
	else catalog.resourceListError = resources.reason instanceof McpError ? resources.reason.message : "MCP resource listing failed";
	if (templates.status === "fulfilled") catalog.templates = templates.value.map(({ uriTemplate, name, mimeType, description, title }) =>
		({ uriTemplate, name, ...mimeType && { mimeType }, ...description && { description }, ...title && { title } }));
	else catalog.templateListError = templates.reason instanceof McpError ? templates.reason.message : "MCP template listing failed";
	return normalizeMcpResult(server, "resources/list", { content: [], structuredContent: catalog, isError: resources.status === "rejected" || templates.status === "rejected" }, options, started);
}

export class McpResourceSource implements ToolSource {
	acquire(context: ToolSourceContext, signal?: AbortSignal): AcquiredToolSource {
		const life = sourceLifetime(signal), { binding, model, outputDirectory } = context;
		const servers = [...binding.servers.values()].filter(server => server.capabilities.resources).map(server => server.serverId).sort();
		const tools: AgentTool[] = [], diagnostics: string[] = [];
		for (const read of servers.length ? [false, true] : []) {
			const name = read ? "mcp_read_resource" : "mcp_list_resources", operation = read ? "resources/read" : "resources/list";
			if (context.reservedNames.has(name)) { diagnostics.push("MCP 工具名称冲突: " + name); continue; }
			const properties = { server: { type: "string", enum: servers }, ...(read ? { uri: { type: "string", pattern: absoluteResourceUri.source } } : {}) };
			tools.push({ name, label: name,
				description: read ? "Read one URI from the specified MCP server." : "List resources and URI templates from one MCP server.",
				parameters: { type: "object", properties, required: read ? ["server", "uri"] : ["server"], additionalProperties: false },
				resolvePermission(args) {
					const { server: id, uri } = args as { server: string; uri?: string };
					return { provider: "mcp", scopeKey: resourceServer(binding, id).identity, actionKey: digest([operation, uri]),
						label: safeText(id + " / " + operation + (uri ? " · " + uri : "")) };
				},
				async execute(_callId, args, callSignal) {
					const started = Date.now(), { server, uri } = args as { server: string; uri: string };
					const options = { outputDirectory, signal: life.callSignal(callSignal), images: model.capabilities?.images };
					try {
						throwCancelled(options.signal);
						return read ? await readResource(binding, server, uri, options) : await listResources(binding, server, options);
					} catch (error) { return failedResult(server, operation, started, error); }
				},
			});
		}
		return { tools, instructions: [], diagnostics, release: life.release };
	}
}
