import { parseMcpConfig } from "../../config/mcp.ts";
import { McpRuntime } from "../../mcp/runtime.ts";
import { McpError, type McpCatalogKind, type McpScope, type McpServerConfig } from "../../mcp/types.ts";
import { safeText } from "../../mcp/util.ts";
import type { CommandDialogController, ConfigField } from "../../tui/commands/command-dialog-controller.ts";
import { spawn } from "node:child_process";
import { join } from "node:path";

interface Options {
	runtime: McpRuntime; dialogs: CommandDialogController; interactive: boolean; write: (text: string) => void;
	start: (action: (signal: AbortSignal) => Promise<void>) => void;
}
const usage = "/mcp [list|status [server]|show server|add|edit server|delete server|trust server|enable server|disable server|connect server|reconnect server|login server|logout server|tools server|resources server|templates server|prompts server|reload]";
const catalogs: readonly string[] = ["tools", "resources", "templates", "prompts"];
const yesNo = ["true", "false"];
const text = (value: string) => safeText(value).slice(0, 16000);
function openBrowser(url: string): Promise<void> {
	const command = process.platform === "darwin" ? "/usr/bin/open" : process.platform === "win32" ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "rundll32.exe") : "xdg-open";
	return new Promise((resolve, reject) => {
		const child = spawn(command, process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url], { stdio: "ignore", windowsHide: true, timeout: 5000 });
		child.once("error", reject); child.once("exit", code => code === 0 ? resolve() : reject(new Error("Browser unavailable")));
	});
}

/** Routing stays in the shared slash-command registry; this class owns only /mcp's menu and subcommands. */
export class McpCommand {
	constructor(private readonly options: Options) {}
	private get runtime() { return this.options.runtime; }
	private get dialogs() { return this.options.dialogs; }
	async run(argument: string, signal?: AbortSignal) {
		const [subcommand, id, ...rest] = argument.trim().split(/\s+/), verb = subcommand === "show" ? "status" : subcommand;
		if (!verb) { if (this.options.interactive) this.menu(); else this.list(); return; }
		if (rest.length || !["list", "status", "reload", "add", "edit", "delete", "trust", "enable", "disable", "connect", "reconnect", "login", "logout", ...catalogs].includes(verb)
			|| (["list", "reload", "add"].includes(verb) && id) || (!["list", "status", "reload", "add"].includes(verb) && !id)) throw new McpError("config", usage);
		if (verb === "list" || verb === "status") { this.list(id); return; }
		if (verb === "reload") { await this.runtime.reload(); this.options.write("MCP 配置已重新加载。"); return; }
		if (["add", "edit", "delete", "trust", "login"].includes(verb) && !this.options.interactive) throw new McpError("unsupported", "此 MCP 操作需要交互终端；管道模式不会自动信任或登录。");
		if (verb === "add") { this.add(); return; }
		if (verb === "edit") { this.edit(id); return; }
		if (verb === "delete") { this.remove(id); return; }
		if (verb === "trust") { this.trust(id); return; }
		if (catalogs.includes(verb)) { await this.catalog(id, verb as McpCatalogKind, signal); return; }
		if (verb === "enable" || verb === "disable") await this.runtime.setEnabled(id, verb === "enable");
		else if (verb === "connect") await this.runtime.connectServerAndDiscover(id, signal);
		else if (verb === "reconnect") await this.runtime.reconnect(id, signal);
		else if (verb === "logout") await this.runtime.logout(id);
		else if (verb === "login") {
			const cancel = new AbortController();
			try { await this.runtime.login(id, url => {
				this.dialogs.openPicker({ title: "MCP 登录", description: "请在浏览器中完成授权。", choices: [{ id: "cancel", label: "取消登录" }], onAccept: () => cancel.abort(), onBack: () => cancel.abort() });
				void openBrowser(url).catch(() => this.options.write(`无法自动打开浏览器，请手动打开：\n${url}`));
			}, AbortSignal.any([cancel.signal, ...(signal ? [signal] : [])])); }
			finally { this.dialogs.close(); }
		}
		this.list(id);
	}
	private list(id?: string) {
		const snapshot = this.runtime.getSnapshot(), servers = id ? snapshot.servers.filter(server => server.id === id) : snapshot.servers;
		if (id && !servers.length) throw new McpError("config", "MCP 服务器不存在。");
		const lines = servers.map(server => `${server.id} · ${server.status} · ${server.type} · ${server.source.scope}\n  ${server.source.path}`
			+ (server.overridden ? `\n  overrides ${server.overridden.path}` : "")
			+ (server.protocolVersion ? `\n  protocol ${server.protocolVersion} (${server.protocolEra})` : "")
			+ `\n  tools: ${server.catalogs.tools.status === "ready" ? server.catalogs.tools.items.length : server.catalogs.tools.status}; resources: ${server.catalogs.resources.status}; prompts: ${server.catalogs.prompts.status}`
			+ (server.error ? `\n  ${server.error.code}: ${server.error.message}` : ""));
		this.options.write(text([...lines, ...snapshot.diagnostics.map(item => `${item.code}: ${item.message}`)].join("\n") || "尚未配置 MCP 服务器。"));
	}
	menu() {
		const snapshot = this.runtime.getSnapshot();
		this.dialogs.openPicker({ title: "MCP 服务器", description: snapshot.diagnostics.map(item => item.message).join("\n") || "选择服务器查看状态、连接和能力目录。",
			choices: [...snapshot.servers.map(server => ({ id: server.id, label: server.id, literal: true, description: `${server.status} · ${server.type} · ${server.source.scope}`, descriptionLiteral: true })),
				{ id: ":add", label: "＋ 新增 MCP 服务器" }, { id: ":reload", label: "重新加载 MCP 配置" }],
			onAccept: id => { if (id === ":add") this.add(); else if (id === ":reload") this.act(() => this.runtime.reload()); else this.detail(id); } });
	}
	private act(action: (signal: AbortSignal) => Promise<unknown>, id?: string) {
		this.options.start(async signal => { await action(signal); if (!signal.aborted) { if (id) this.detail(id); else this.menu(); } });
	}
	private detail(id: string) {
		const server = this.runtime.getSnapshot().servers.find(server => server.id === id);
		if (!server) { this.menu(); return; }
		this.dialogs.openPicker({ title: `MCP · ${id}`, description: text(`${server.status} · ${server.type} · ${server.source.scope}\n${server.source.path}`
			+ (server.protocolVersion ? `\nprotocol ${server.protocolVersion} (${server.protocolEra})` : "")
			+ (server.overridden ? `\noverrides ${server.overridden.path}` : "") + (server.error ? `\n${server.error.message}` : "")),
			choices: [
				...(!server.trusted ? [{ id: "trust", label: "信任此项目服务器" }] : []),
				{ id: "reconnect", label: "连接／重新连接" }, { id: server.enabled ? "disable" : "enable", label: server.enabled ? "停用服务器" : "启用服务器" },
				...catalogs.map(kind => ({ id: kind, label: `${kind} · ${server.catalogs[kind as McpCatalogKind].status}`, literal: true })),
				{ id: "login", label: "OAuth 登录" }, { id: "logout", label: "OAuth 退出登录" },
				{ id: "edit", label: "修改服务器配置" }, { id: "delete", label: "删除服务器配置" },
			], onBack: () => this.menu(), onAccept: verb => {
				if (verb === "edit") this.edit(id); else if (verb === "delete") this.remove(id); else if (verb === "trust") this.trust(id);
				else if (catalogs.includes(verb)) this.options.start(signal => this.catalog(id, verb as McpCatalogKind, signal));
				else this.act(signal => this.run(`${verb} ${id}`, signal), id);
			} });
	}
	private async catalog(id: string, kind: McpCatalogKind, signal?: AbortSignal) {
		const items = await this.runtime.list(id, kind, { signal });
		const show = (value: unknown) => {
			const serialized = JSON.stringify(value, null, 2);
			this.options.write(`${id} · ${kind}\n${text(serialized)}${serialized.length > 16000 ? "\n… MCP 定义超过展示长度。" : ""}`);
		};
		if (!this.options.interactive) { show(items); return; }
		this.dialogs.openPicker({ title: `${id} · ${kind} (${items.length})`, description: "选择条目查看完整定义。", onBack: () => this.detail(id),
			choices: items.map((item, index) => ({ id: String(index), label: text(item.name), literal: true, description: text(item.description ?? ""), descriptionLiteral: true })),
			onAccept: index => { this.dialogs.close(); show(items[Number(index)]); } });
	}
	private trust(id: string) {
		const definition = this.runtime.getConfig().servers.find(server => server.id === id);
		if (!definition) throw new McpError("config", "MCP 服务器不存在。");
		const config = definition.config;
		const destination = config.type === "stdio" ? `${config.command}\ncwd: ${config.cwd}\nargs: ${config.args.length}（完整参数见配置文件）` : (() => { const url = new URL(config.url); url.search = ""; return url.href; })();
		this.dialogs.openPicker({ title: "信任项目 MCP 配置", description: text(`${definition.source.path}\n${destination}\n确认后允许启动此命令或连接此地址。配置更改后需要重新信任。`),
			choices: [{ id: "cancel", label: "取消" }, { id: "trust", label: "信任此配置" }], onBack: () => this.detail(id),
			onAccept: action => { if (action === "trust") this.act(() => this.runtime.trust(id, definition.trustKey), id); else this.detail(id); } });
	}
	private remove(id: string) {
		const candidate = this.runtime.getConfig(), definition = candidate.servers.find(server => server.id === id);
		if (!definition) throw new McpError("config", "MCP 服务器不存在。");
		this.dialogs.openPicker({ title: "删除 MCP 配置", description: text(`${definition.source.path}\n${definition.overridden ? "删除项目配置后，同名用户配置将重新生效。" : "删除后将关闭此服务器连接。"}`),
			choices: [{ id: "cancel", label: "取消" }, { id: "delete", label: "删除" }], onBack: () => this.detail(id),
			onAccept: action => { if (action === "delete") this.act(() => this.runtime.save(definition.source.scope, id, undefined, candidate.digests[definition.source.scope])); else this.detail(id); } });
	}
	private add() {
		this.dialogs.openPicker({ title: "MCP 保存范围", choices: [{ id: "project", label: "当前项目", current: true }, { id: "user", label: "所有项目（用户配置）" }], onBack: () => this.menu(),
			onAccept: scope => this.dialogs.openPicker({ title: "MCP 传输方式", choices: [{ id: "stdio", label: "stdio · 本地命令", literal: true }, { id: "http", label: "HTTP · 远程地址", literal: true }],
				onBack: () => this.add(), onAccept: type => this.form(scope as McpScope, type as "stdio" | "http") }) });
	}
	private edit(id: string) {
		const candidate = this.runtime.getConfig(), definition = candidate.servers.find(server => server.id === id);
		if (!definition) throw new McpError("config", "MCP 服务器不存在。");
		this.form(definition.source.scope, definition.config.type, id);
	}
	private form(scope: McpScope, type: "stdio" | "http", id?: string) {
		const candidate = this.runtime.getConfig(), original = id ? candidate.documents[scope].mcpServers[id] : undefined;
		const config = original ?? { type };
		const field = (key: string, label: string, fallback: unknown = "", options?: readonly string[], secret = false): ConfigField => {
			const value = (config as unknown as Record<string, unknown>)[key] ?? fallback;
			return { key, label, value: secret && original ? "" : typeof value === "string" ? value : JSON.stringify(value), options, secret,
				...(secret && original ? { placeholder: "留空保留原值；输入 {} 清空。" } : {}) };
		};
		const fields: ConfigField[] = [...(!id ? [{ key: "id", label: "服务器名称", value: "" }] : []),
			...(type === "stdio" ? [field("command", "启动命令"), field("args", "参数（JSON 数组）", [], undefined, true), field("cwd", "工作目录（可选）"),
				field("envVars", "继承环境变量名（JSON 数组）", []), field("env", "固定环境变量（JSON 对象）", {}, undefined, true)]
				: [field("url", "HTTP URL"), field("auth", "认证（JSON 对象）", { type: "none" }), field("envHeaders", "请求头到环境变量名（JSON 对象）", {}), field("headers", "固定请求头（JSON 对象）", {}, undefined, true)]),
			field("enabled", "默认启用", true, yesNo), field("startupTimeoutMs", "连接期限（毫秒）", 10000), field("requestTimeoutMs", "请求期限（毫秒）", 60000),
			field("outputMaxBytes", "输出预算（字节）", 32768), field("enabledTools", "允许的工具（JSON 数组；留空允许全部）", ""), field("disabledTools", "禁用的工具（JSON 数组）", [])];
		this.dialogs.openForm({ title: id ? `MCP · ${id}` : "新增 MCP 服务器", saveLabel: "保存 MCP 配置", description: candidate.paths[scope], fields,
			onBack: () => id ? this.detail(id) : this.add(), onSave: values => {
				const serverId = id ?? values.id;
				if (!id && Object.hasOwn(candidate.documents[scope].mcpServers, serverId)) throw new McpError("config", "该范围内已存在同名 MCP 服务器。");
				const next: Record<string, unknown> = { type };
				for (const [key, value] of Object.entries(values)) {
					if (key === "id") continue;
					if (["args", "env", "headers"].includes(key) && !value && original) { next[key] = (original as unknown as Record<string, unknown>)[key]; continue; }
					if ((key === "cwd" || key === "enabledTools") && !value) continue;
					if (["command", "cwd", "url"].includes(key)) next[key] = value;
					else try { next[key] = JSON.parse(value); } catch { throw new McpError("config", `MCP 字段 ${key} 不是有效的 JSON。`); }
				}
				const parsed: McpServerConfig = parseMcpConfig(JSON.stringify({ mcpServers: { [serverId]: next } })).mcpServers[serverId];
				this.act(async () => { await this.runtime.save(scope, serverId, parsed, candidate.digests[scope]); this.options.write("MCP 配置已保存；项目配置需要信任后连接。"); }, serverId);
			} });
	}
}
