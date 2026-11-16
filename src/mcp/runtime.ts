import { McpConfigStore } from "../config/mcp.ts";
import { getAppPaths, type AppPaths, type StorageOptions } from "../storage/app-paths.ts";
import { credentialKey, McpOAuthProvider } from "./auth.ts";
import { McpConnection } from "./connection.ts";
import { McpLocalState } from "./local-state.ts";
import { McpError, type JsonObject, type McpBinding, type McpCatalogItems, type McpCatalogKind, type McpConfigCandidate,
	type McpDiagnostic, type McpRequestOptions, type McpRuntimeSnapshot, type McpScope, type McpServerBinding,
	type McpServerDefinition, type McpServerSnapshot } from "./types.ts";
import { abortable, deadline, diagnostic, digest, freeze, MCP_LIMITS, SharedTask, throwCancelled } from "./util.ts";

interface Entry {
	definition: McpServerDefinition; enabled: boolean; trusted: boolean; generation: number;
	connection?: McpConnection; connectionIdentity?: string; pending?: SharedTask<McpConnection>; error?: McpDiagnostic;
}
export interface McpRuntimeOptions extends StorageOptions { cwd: string; paths?: AppPaths; assertIdle?: () => void }
const emptyCatalog = () => ({ status: "unloaded" as const, revision: 0, items: [] });

/** Owned by Harness. Configuration loading is lazy and never starts a server. */
export class McpRuntime {
	readonly config: McpConfigStore;
	private readonly local: McpLocalState;
	private candidate?: McpConfigCandidate;
	private loaded = false;
	private readonly entries = new Map<string, Entry>();
	private readonly listeners = new Set<() => void>();
	private readonly lifetime = new AbortController();
	private diagnostics: McpDiagnostic[] = [];
	private bindings = new Set<AbortController>();
	private mutation = false;
	private mutationDone?: Promise<void>;
	private generation = 0;
	private activeConnections = 0;
	private readonly slotWaiters = new Set<() => void>();
	private closing?: Promise<void>;
	constructor(private readonly options: McpRuntimeOptions) {
		this.config = new McpConfigStore(options.cwd, options.paths ?? getAppPaths(options));
		this.local = new McpLocalState(this.config.stateDirectory);
	}
	subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
	private publish = () => { for (const listener of this.listeners) listener(); };
	private ensureLoaded() {
		if (this.loaded) return;
		this.loaded = true;
		try { const candidate = this.config.load(); const entries = this.prepare(candidate); this.candidate = candidate; for (const entry of entries) this.entries.set(entry.definition.id, entry); }
		catch (error) { this.diagnostics = [diagnostic(error)]; }
	}
	private prepare(candidate: McpConfigCandidate): Entry[] {
		return candidate.servers.map(definition => ({ definition, generation: ++this.generation,
			enabled: this.local.getEnabled(McpLocalState.scopeKey(this.config.cwd, definition.id)) ?? definition.config.enabled,
			trusted: definition.source.scope === "user" || this.local.isTrusted(definition.trustKey) }));
	}
	getConfig(): McpConfigCandidate { this.ensureLoaded(); if (!this.candidate) throw new McpError("config", "MCP 配置无效，请修正文件后 reload。"); return this.candidate; }
	getSnapshot(): McpRuntimeSnapshot {
		this.ensureLoaded();
		return freeze({ servers: [...this.entries.values()].map(entry => this.snapshot(entry)), diagnostics: [...this.diagnostics], closed: this.lifetime.signal.aborted });
	}
	private snapshot(entry: Entry): McpServerSnapshot {
		const { definition, connection } = entry, error = entry.error ?? connection?.error;
		return { id: definition.id, type: definition.config.type, source: definition.source, overridden: definition.overridden,
			enabled: entry.enabled, trusted: entry.trusted, generation: entry.generation,
			status: !entry.enabled ? "disabled" : !entry.trusted ? "untrusted" : entry.pending ? "connecting" : connection?.ready ? "ready"
				: error?.code === "needs-auth" ? "needs-auth" : error ? "failed" : "disconnected",
			protocolVersion: connection?.protocolVersion, protocolEra: connection?.protocolEra,
			serverName: connection?.serverInfo?.name, serverVersion: connection?.serverInfo?.version,
			capabilities: connection?.capabilities ?? { tools: false, resources: false, prompts: false },
			catalogs: connection?.getCatalogs() ?? { tools: emptyCatalog(), resources: emptyCatalog(), templates: emptyCatalog(), prompts: emptyCatalog() },
			error, stderr: connection?.stderr ?? "" };
	}
	private entry(id: string): Entry {
		this.ensureLoaded(); if (this.lifetime.signal.aborted) throw new McpError("closed", "MCP 已关闭。");
		const entry = this.entries.get(id); if (!entry) throw new McpError("config", "MCP 服务器不存在。"); return entry;
	}
	private assertMutable() {
		if (this.lifetime.signal.aborted) throw new McpError("closed", "MCP 已关闭。");
		if (this.mutation || this.bindings.size) throw new McpError("busy", "MCP 正在使用，请等待当前操作结束。");
		this.options.assertIdle?.();
	}
	private async mutate<T>(run: () => Promise<T>): Promise<T> {
		this.assertMutable(); this.mutation = true;
		let done!: () => void; this.mutationDone = new Promise(resolve => { done = resolve; });
		try { return await run(); } finally { this.mutation = false; done(); this.mutationDone = undefined; this.publish(); }
	}
	private async stop(entry: Entry) {
		entry.generation = ++this.generation;
		entry.pending?.controller.abort();
		await Promise.allSettled([entry.pending?.promise, entry.connection?.close()]);
		entry.pending = undefined; entry.connection = undefined;
	}
	private async apply(candidate: McpConfigCandidate, prepared = this.prepare(candidate)) {
		const obsolete: Entry[] = [];
		for (const entry of this.entries.values()) {
			const next = prepared.find(value => value.definition.id === entry.definition.id);
			if (!next || entry.definition.configKey !== next.definition.configKey || entry.enabled !== next.enabled || entry.trusted !== next.trusted) obsolete.push(entry);
		}
		await Promise.all(obsolete.map(entry => this.stop(entry)));
		const previous = new Map(this.entries); this.entries.clear();
		for (const entry of prepared) {
			const old = previous.get(entry.definition.id);
			if (old && !obsolete.includes(old)) { old.definition = entry.definition; this.entries.set(entry.definition.id, old); }
			else this.entries.set(entry.definition.id, entry);
		}
		this.candidate = candidate; this.loaded = true; this.diagnostics = []; this.publish();
	}
	async reload() {
		return this.mutate(async () => {
			try { await this.apply(this.config.load()); }
			catch (error) { this.diagnostics = [diagnostic(error)]; throw error; }
		});
	}
	async save(scope: McpScope, id: string, value: unknown | undefined, expectedDigest?: string) {
		return this.mutate(async () => {
			// Read private state before writing a configuration candidate.
			this.prepare(this.config.load());
			await this.apply(this.config.save(scope, id, value, expectedDigest));
		});
	}
	async trust(id: string, expectedKey?: string) { return this.mutate(async () => {
		const entry = this.entry(id);
		if (expectedKey !== undefined && entry.definition.trustKey !== expectedKey) throw new McpError("config", "MCP 配置已变化，请重新查看后信任。");
		this.local.trust(entry.definition.trustKey); entry.trusted = true; entry.error = undefined;
	}); }
	async setEnabled(id: string, enabled: boolean) {
		return this.mutate(async () => { const entry = this.entry(id); this.local.setEnabled(McpLocalState.scopeKey(this.config.cwd, id), enabled); await this.stop(entry); entry.enabled = enabled; entry.error = undefined; });
	}
	async reconnect(id: string, signal?: AbortSignal) {
		return this.mutate(async () => { const entry = this.entry(id); await this.stop(entry); return this.connectServerAndDiscover(id, signal); });
	}
	async login(id: string, showUrl: (url: string) => void, signal?: AbortSignal) {
		return this.mutate(async () => {
			const entry = this.entry(id); this.assertAllowed(entry);
			const config = entry.definition.config;
			if (config.type !== "http" || config.auth.type !== "oauth") throw new McpError("unsupported", "此 MCP 服务器未配置 OAuth 登录。");
			await this.stop(entry);
			const budget = deadline(MCP_LIMITS.loginMs, signal, this.lifetime.signal);
			try { await new McpOAuthProvider(config.auth, credentialKey(config), this.local).login(config.url, showUrl, budget.signal); entry.error = undefined; }
			catch (error) { entry.error = diagnostic(error); throw new McpError(entry.error.code, entry.error.message); }
			finally { budget.dispose(); }
		});
	}
	async logout(id: string) {
		return this.mutate(async () => {
			const entry = this.entry(id), config = entry.definition.config;
			if (config.type !== "http" || config.auth.type !== "oauth") throw new McpError("unsupported", "此 MCP 服务器未配置 OAuth 登录。");
			await this.stop(entry); this.local.logout(credentialKey(config)); entry.error = { code: "needs-auth", message: "MCP 已退出登录。" };
		});
	}
	private assertAllowed(entry: Entry) {
		if (!entry.enabled) throw new McpError("disabled", "MCP 服务器已停用。");
		if (!entry.trusted) throw new McpError("untrusted", "项目 MCP 配置需要显式信任后才能连接。");
	}
	private async slot(signal: AbortSignal) {
		while (this.activeConnections >= MCP_LIMITS.concurrentConnections) {
			let wake!: () => void;
			try { await abortable(new Promise<void>(resolve => { wake = resolve; this.slotWaiters.add(wake); }), signal); }
			finally { this.slotWaiters.delete(wake); }
		}
		throwCancelled(signal); this.activeConnections++;
		return () => { this.activeConnections--; for (const wake of this.slotWaiters) wake(); this.slotWaiters.clear(); };
	}
	async connectServerAndDiscover(id: string, signal?: AbortSignal): Promise<McpServerSnapshot> {
		const entry = this.entry(id); await this.connection(entry, signal); return freeze(this.snapshot(entry));
	}
	private async connection(entry: Entry, signal?: AbortSignal): Promise<McpConnection> {
		throwCancelled(signal); this.assertAllowed(entry);
		if (entry.connection?.ready && entry.connectionIdentity === this.identity(entry)) return entry.connection;
		if (!entry.pending || entry.pending.controller.signal.aborted) {
			const previous = entry.pending;
			const task = new SharedTask(async taskSignal => {
				const budget = deadline(entry.definition.config.startupTimeoutMs, taskSignal, this.lifetime.signal);
				let release: (() => void) | undefined;
				try {
					if (previous) await abortable(previous.promise.catch(() => {}), budget.signal);
					release = await this.slot(budget.signal);
					await entry.connection?.close();
					const connection = new McpConnection(entry.definition, ++this.generation, this.config.cwd, this.local, this.publish);
					entry.generation = connection.generation; entry.connection = connection; entry.error = undefined; this.publish();
					await connection.connect(budget.signal); entry.connectionIdentity = this.identity(entry); return connection;
				} catch (error) { entry.error = diagnostic(error); throw error; }
				finally { budget.dispose(); release?.(); }
			});
			entry.pending = task;
			void task.promise.finally(() => { if (entry.pending === task) entry.pending = undefined; this.publish(); }).catch(() => {});
		}
		return entry.pending.wait(signal);
	}
	async list<K extends McpCatalogKind>(id: string, kind: K, options?: McpRequestOptions): Promise<readonly McpCatalogItems[K][]> {
		const connection = await this.connection(this.entry(id), options?.signal); return connection.list(kind, options);
	}
	private identity(entry: Entry) {
		const config = entry.definition.config;
		const environment = config.type === "stdio" ? config.envVars.map(name => [name, process.env[name]])
			: [...Object.values(config.envHeaders), ...(config.auth.type === "bearer" ? [config.auth.tokenEnv] : [])].map(name => [name, process.env[name]]);
		return digest({ config: entry.definition.configKey, environment,
			auth: config.type === "http" && config.auth.type === "oauth" ? this.local.getCredentials(credentialKey(config))?.identity ?? "none" : "none" });
	}
	async acquireBinding(signal?: AbortSignal): Promise<McpBinding> {
		this.ensureLoaded(); throwCancelled(signal);
		if (this.lifetime.signal.aborted) throw new McpError("closed", "MCP 已关闭。");
		if (this.mutation) throw new McpError("busy", "MCP 配置正在更新。");
		const controller = new AbortController(), linked = AbortSignal.any([controller.signal, this.lifetime.signal, ...(signal ? [signal] : [])]);
		this.bindings.add(controller);
		const pinned = new Map<string, { entry: Entry; connection: McpConnection; binding: McpServerBinding; revisions: Partial<Record<McpCatalogKind, number>> }>();
		let released = false;
		const release = () => { if (released) return; released = true; controller.abort(); this.bindings.delete(controller); };
		try {
			await Promise.all([...this.entries.values()].filter(entry => entry.enabled && entry.trusted).map(async entry => {
				try {
					const connection = await this.connection(entry, linked);
					if (connection.capabilities.tools && connection.getCatalogs().tools.status !== "ready") await connection.list("tools", { signal: linked }).catch(() => {});
					throwCancelled(linked);
					if (!connection.ready) return;
					const catalog = connection.getCatalogs().tools;
					const tools = catalog.status === "ready" ? catalog.items.filter(tool => !entry.definition.config.disabledTools.includes(tool.name)
						&& (!entry.definition.config.enabledTools || entry.definition.config.enabledTools.includes(tool.name))) : [];
					const binding = freeze({ serverId: entry.definition.id, generation: entry.generation, identity: this.identity(entry),
						toolRevision: catalog.revision, capabilities: connection.capabilities, tools, instructions: connection.instructions,
						outputMaxBytes: entry.definition.config.outputMaxBytes });
					pinned.set(entry.definition.id, { entry, connection, binding, revisions: { tools: catalog.revision } });
				} catch { /* One server's failure is visible in its snapshot and must not block others. */ }
			}));
			throwCancelled(linked);
			const check = (id: string, kind?: McpCatalogKind) => {
				if (released) throw new McpError("binding-invalid", "MCP 绑定已释放。");
				throwCancelled(linked);
				const item = pinned.get(id);
				if (!item || this.entries.get(id) !== item.entry || !item.connection.ready || item.entry.generation !== item.binding.generation || this.identity(item.entry) !== item.binding.identity)
					throw new McpError("binding-invalid", "MCP 连接或授权身份已变化，请重新获取绑定。");
				if (kind) {
					const state = item.connection.getCatalogs()[kind];
					if (state.status === "unsupported") throw new McpError("unsupported", "MCP 服务器不支持该能力。");
					if (item.revisions[kind] !== undefined && (state.status !== "ready" || state.revision !== item.revisions[kind])) throw new McpError("catalog-changed", "MCP 目录已变化，请重新获取绑定。");
				}
				return item;
			};
			const opts = (options?: McpRequestOptions) => ({ ...options, signal: AbortSignal.any([linked, ...(options?.signal ? [options.signal] : [])]) });
			const list = async <K extends McpCatalogKind>(id: string, kind: K, options?: McpRequestOptions): Promise<readonly McpCatalogItems[K][]> => {
				const item = check(id, kind);
				const result = await item.connection.list(kind, opts(options)); check(id);
				const revision = item.connection.getCatalogs()[kind].revision;
				if (item.revisions[kind] === undefined) item.revisions[kind] = revision;
				check(id, kind); return kind === "tools" ? item.binding.tools as readonly McpCatalogItems[K][] : result;
			};
			const servers = new Map([...pinned].map(([id, item]) => [id, item.binding]));
			const readonlyServers: ReadonlyMap<string, McpServerBinding> = Object.freeze({ get size() { return servers.size; }, get: servers.get.bind(servers), has: servers.has.bind(servers),
				keys: servers.keys.bind(servers), values: servers.values.bind(servers), entries: servers.entries.bind(servers),
				[Symbol.iterator]: servers[Symbol.iterator].bind(servers), forEach: (callback: (value: McpServerBinding, key: string, map: ReadonlyMap<string, McpServerBinding>) => void, thisArg?: unknown) => servers.forEach((value, key) => callback.call(thisArg, value, key, readonlyServers)) });
			return Object.freeze({ servers: readonlyServers,
				listTools: (id: string, options?: McpRequestOptions) => list(id, "tools", options),
				listResources: (id: string, options?: McpRequestOptions) => list(id, "resources", options),
				listResourceTemplates: (id: string, options?: McpRequestOptions) => list(id, "templates", options),
				listPrompts: (id: string, options?: McpRequestOptions) => list(id, "prompts", options),
				callTool: async (id: string, name: string, args: JsonObject, options?: McpRequestOptions) => {
					const item = check(id, "tools"), tool = item.binding.tools.find(tool => tool.name === name);
					if (!tool) throw new McpError("disabled", "MCP 工具不存在或已被配置禁用。");
					const result = await item.connection.callTool(tool, args, opts(options)); check(id, "tools"); return result;
				},
				readResource: async (id: string, uri: string, options?: McpRequestOptions) => {
					const item = check(id); if (!item.binding.capabilities.resources) throw new McpError("unsupported", "MCP 服务器不支持资源读取。");
					if (item.revisions.resources !== undefined) check(id, "resources"); if (item.revisions.templates !== undefined) check(id, "templates");
					const result = await item.connection.readResource(uri, opts(options)); check(id);
					if (item.revisions.resources !== undefined) check(id, "resources"); if (item.revisions.templates !== undefined) check(id, "templates"); return result;
				},
				getPrompt: async (id: string, name: string, args: Record<string, string>, options?: McpRequestOptions) => {
					const prompts = await list(id, "prompts", options), item = check(id, "prompts");
					if (!prompts.some(prompt => prompt.name === name)) throw new McpError("protocol", "MCP 提示模板不存在。");
					const result = await item.connection.getPrompt(name, args, opts(options)); check(id, "prompts"); return result;
				}, release });
		} catch (error) { release(); throw error; }
	}
	close(): Promise<void> {
		if (this.closing) return this.closing;
		this.lifetime.abort(); for (const binding of this.bindings) binding.abort(); this.bindings.clear();
		this.closing = Promise.all([this.mutationDone, ...[...this.entries.values()].map(entry => this.stop(entry))]).then(() => { this.publish(); this.listeners.clear(); });
		return this.closing;
	}
}
