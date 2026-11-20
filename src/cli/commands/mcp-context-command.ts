import { join } from "node:path";
import { McpRuntime } from "../../mcp/runtime.ts";
import { McpError, type McpBinding, type McpPromptDefinition } from "../../mcp/types.ts";
import { readMcpResource } from "../../mcp/resource-source.ts";
import { prepareMcpPromptDraft } from "../../mcp/prompt-service.ts";
import { templateVariables, expandResourceTemplate, type TemplateValue } from "../../mcp/uri-template.ts";
import { displayText } from "../../tui/utils/text.ts";
import type { CommandDialogController, CommandChoice, ConfigField } from "../../tui/commands/command-dialog-controller.ts";
import type { PromptInputController } from "../input/prompt-input-controller.ts";
import type { PromptSubmission } from "../input/prompt-draft.ts";

type ContextCommand = "mcp-resource" | "mcp-prompt";
export type McpDraftEditor = Pick<PromptInputController, "getRevision" | "insertMaterial">;
export const isMcpContextCommand = (name: string): name is ContextCommand => name === "mcp-resource" || name === "mcp-prompt";
const dismissed = Symbol("dismissed");

function parseArguments(input: string): Record<string, string> {
	let value: unknown;
	try { value = JSON.parse(input); } catch { throw new Error("MCP 模板参数需要有效的 JSON 对象。"); }
	if (!value || typeof value !== "object" || Array.isArray(value) || Object.values(value).some(v => typeof v !== "string")) {
		throw new Error("MCP 模板参数必须是字符串值的 JSON 对象。");
	}
	return Object.fromEntries(Object.entries(value)) as Record<string, string>;
}

function templateValues(form: Record<string, string>): Record<string, TemplateValue> {
	return Object.fromEntries(Object.entries(form).map(([name, input]) => {
		if (!/^\s*["\[{]/u.test(input)) return [name, input];
		let value: unknown;
		try { value = JSON.parse(input); } catch { throw new Error("资源变量需要文本或有效的 JSON 值。"); }
		if (typeof value === "string" || (value && typeof value === "object" && Object.values(value).every(v => typeof v === "string"))) {
			return [name, value as TemplateValue];
		}
		throw new Error("资源变量支持字符串、字符串数组或字符串值对象。");
	}));
}

/** One operation owns the dialog, connection binding and original editor revision. */
export class McpContextCommand {
	constructor(private readonly runtime: McpRuntime, private readonly dialogs: CommandDialogController,
		private readonly editor?: McpDraftEditor) {}

	async run(command: ContextCommand, argument: string, interactive: boolean, signal: AbortSignal): Promise<string | undefined> {
		const resource = command === "mcp-resource";
		const input = argument.trim();
		const match = /^(\S+)(?:\s+(\S+)(?:\s+(.+))?)?$/su.exec(input);
		const [, serverArg, target, json] = match ?? [];
		const initialRevision = this.editor?.getRevision();
		if ((input && !match) || (!interactive && (!serverArg || !target)) || (resource && json)) {
			throw new Error(resource ? "用法：/mcp-resource <server> <uri>" : "用法：/mcp-prompt <server> <name> <JSON>");
		}
		const args = json === undefined ? undefined : parseArguments(json);
		let binding: McpBinding | undefined;
		try {
			const server = serverArg ?? await this.pickServer(signal);
			binding = await this.runtime.acquireBinding(signal, server);
			const options = { signal, images: interactive, outputDirectory: join(this.runtime.toolResultsDir, "mcp") };
			let material: PromptSubmission;
			let rawPrompt: string | undefined;
			if (resource) {
				const uri = target ?? await this.pickResource(binding, server, signal);
				material = await readMcpResource(binding, server, uri, options);
			} else {
				const prompts = await binding.listPrompts(server, { signal });
				const name = target ?? await this.pick("MCP 提示模板", prompts.map((p, i) => ({
					id: String(i), label: p.name, description: p.description, literal: true, descriptionLiteral: true,
				})), signal).then(i => prompts[Number(i)]!.name);
				const prompt = prompts.find(p => p.name === name);
				if (!prompt) throw new McpError("protocol", "MCP 提示模板不存在。");
				const values = args ?? (interactive && !target ? await this.promptArguments(prompt, signal) : {});
				const result = await prepareMcpPromptDraft(binding, server, name, values, options);
				material = result;
				if (interactive) rawPrompt = JSON.stringify(result.raw, null, 2);
			}
			binding.release(); binding = undefined;
			signal.throwIfAborted();
			material = { text: displayText(material.text, "\t"), images: material.images };
			const preview = [material.text, ...material.images.map((image, i) => `[Image #${i + 1} · ${displayText(image.mimeType)}]`)].filter(Boolean).join("\n");
			if (!interactive) return preview;
			if (!this.editor || initialRevision === undefined) throw new Error("当前入口未提供草稿编辑器。");
			await this.preview("MCP 内容预览", preview, "加入草稿", signal, rawPrompt);
			let revision = initialRevision, replaceCommand = true;
			while (!this.editor.insertMaterial(material, revision, replaceCommand)) {
				revision = this.editor.getRevision(); replaceCommand = false;
				await this.preview("草稿已修改，插入到当前光标？", preview, "插入当前草稿", signal);
			}
		} catch (error) {
			if (error !== dismissed) throw error;
		} finally {
			binding?.release();
		}
		return undefined;
	}

	private pickServer(signal: AbortSignal): Promise<string> {
		const servers = this.runtime.getSnapshot().servers.filter(s => s.enabled && s.trusted);
		return this.pick("选择 MCP 服务器", servers.map(s => ({ id: s.id, label: s.id, description: s.source.scope, literal: true })), signal);
	}

	private async pickResource(binding: McpBinding, server: string, signal: AbortSignal): Promise<string> {
		if (!binding.servers.get(server)?.capabilities.resources) throw new McpError("unsupported", "MCP 服务器不支持资源读取。");
		const [resourceList, templateList] = await Promise.allSettled([
			binding.listResources(server, { signal }), binding.listResourceTemplates(server, { signal }),
		]);
		signal.throwIfAborted();
		const resources = resourceList.status === "fulfilled" ? resourceList.value : [];
		const templates = templateList.status === "fulfilled" ? templateList.value : [];
		const errors = [resourceList, templateList].flatMap(r => r.status === "rejected" && r.reason instanceof Error ? [r.reason.message] : []);
		const choices: CommandChoice[] = [
			...resources.map((r, i) => ({ id: `r${i}`, label: r.name, description: r.uri, literal: true, descriptionLiteral: true })),
			...templates.map((r, i) => ({ id: `t${i}`, label: r.name, description: r.uriTemplate, literal: true, descriptionLiteral: true })),
			{ id: "uri", label: "输入资源 URI" },
		];
		const choice = await this.pick("MCP 资源", choices, signal, errors.join(" · "));
		if (choice === "uri") return this.dialog(signal, (done, cancel) =>
			this.dialogs.openInput({ title: "输入资源 URI", onAccept: uri => {
				if (!uri.trim()) throw new Error("请输入资源 URI。");
				done(uri.trim());
			}, onBack: cancel }));
		const index = Number(choice.slice(1));
		if (choice.startsWith("r")) return resources[index]!.uri;
		const template = templates[index]!.uriTemplate;
		const fields = templateVariables(template).map(key => ({ key, label: key, value: "", placeholder: "文本或 JSON 字符串、数组、对象" }));
		const values = await this.fields("资源模板参数", fields, signal, templateValues);
		const uri = expandResourceTemplate(template, templateValues(values));
		await this.preview("读取资源 URI", uri, "读取", signal);
		return uri;
	}

	private promptArguments(prompt: McpPromptDefinition, signal: AbortSignal): Promise<Record<string, string>> {
		return this.fields("提示模板参数", (prompt.arguments ?? []).map(arg => ({
			key: arg.name, label: arg.required ? `${arg.name} *` : arg.name, value: "", placeholder: arg.description,
		})), signal, values => {
			for (const a of prompt.arguments ?? []) if (a.required && !values[a.name]) throw new Error(`缺少必填参数：${a.name}`);
		});
	}

	private fields(title: string, fields: ConfigField[], signal: AbortSignal, validate?: (values: Record<string, string>) => void): Promise<Record<string, string>> {
		if (!fields.length) return Promise.resolve({});
		return this.dialog(signal, (done, cancel) => this.dialogs.openForm({ title, fields, saveLabel: "继续", onBack: cancel,
			onSave: values => { validate?.(values); done(Object.fromEntries(Object.entries(values).filter(([,value]) => value !== ""))); } }));
	}

	private pick(title: string, choices: CommandChoice[], signal: AbortSignal, description?: string): Promise<string> {
		if (!choices.length) throw new Error(`${title} · 暂无可选项`);
		return this.dialog(signal, (done, cancel) => this.dialogs.openPicker({ title, choices, description, onAccept: done, onBack: cancel }));
	}

	private preview(title: string, text: string, acceptLabel: string, signal: AbortSignal, alternateText?: string): Promise<void> {
		return this.dialog(signal, (done, cancel) => this.dialogs.openPreview({ title, text, alternateText, acceptLabel, onAccept: done, onBack: cancel }));
	}

	private async dialog<T>(signal: AbortSignal, open: (done: (value: T) => void, cancel: () => void) => void): Promise<T> {
		signal.throwIfAborted();
		let abort: (() => void) | undefined;
		try {
			return await new Promise<T>((resolve, reject) => {
				abort = () => reject(dismissed);
				signal.addEventListener("abort", abort, { once: true });
				open(resolve, abort);
			});
		} finally {
			if (abort) signal.removeEventListener("abort", abort);
			this.dialogs.close();
		}
	}
}
