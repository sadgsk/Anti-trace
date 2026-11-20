import { normalizeMcpResult, toDraft, type McpContentOptions, type McpDraftMaterial } from "./content.ts";
import { McpError, type McpBinding, type McpContent, type McpPromptResult } from "./types.ts";

function publicBlock(block: McpContent): McpContent {
	const { _meta, ...publicFields } = block;
	if (publicFields.type === "resource") {
		const { _meta: metadata, ...resource } = publicFields.resource;
		return { ...publicFields, resource };
	}
	return publicFields;
}

export async function prepareMcpPromptDraft(binding: McpBinding, id: string, name: string, args: Record<string, string>,
	options: McpContentOptions): Promise<McpDraftMaterial & { raw: McpPromptResult }> {
	const started = Date.now(), server = binding.servers.get(id);
	if (!server?.capabilities.prompts) throw new McpError("unsupported", "该 MCP 服务器没有可用的提示模板。");
	if (!args || typeof args !== "object" || Array.isArray(args) || Object.values(args).some(value => typeof value !== "string"))
		throw new McpError("config", "MCP 模板参数必须是字符串值的 JSON 对象。");
	const prompts = await binding.listPrompts(id, { signal: options.signal });
	const prompt = prompts.find(item => item.name === name);
	if (!prompt) throw new McpError("protocol", "找不到 MCP 提示模板。");
	for (const arg of prompt.arguments ?? []) {
		if (arg.required && !Object.hasOwn(args, arg.name)) throw new McpError("config", "缺少模板参数: " + arg.name);
	}
	const response = await binding.getPrompt(id, name, args, { signal: options.signal });
	const raw: McpPromptResult = { description: response.description, messages: response.messages.map(({ role, content }) => ({ role, content: publicBlock(content) })) };
	const content: McpContent[] = [];
	for (const { role, content: block } of raw.messages) {
		content.push({ type: "text", text: role === "assistant" ? "[模板示例回答 / assistant example]" : "[模板用户消息 / user]" }, block);
	}
	const normalized = await normalizeMcpResult(server, "prompts/get", { content }, options, started);
	const source = `[MCP ${id} · ${name} ${JSON.stringify(args)} · ${new Date().toISOString()}]`;
	return { ...await toDraft(normalized, source, options, server.outputMaxBytes), raw };
}
