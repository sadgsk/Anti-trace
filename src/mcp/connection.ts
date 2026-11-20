import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { Client, StreamableHTTPClientTransport, ProtocolError, SdkError, SdkErrorCode, SdkHttpError, UnauthorizedError, InsufficientScopeError, MissingRequiredClientCapabilityError,
	type RequestOptions, type McpSubscription, type Tool } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { McpOAuthProvider, credentialKey, requiredEnv } from "./auth.ts";
import { McpCatalog } from "./catalog.ts";
import { boundedFetch } from "./http.ts";
import { stdioLaunch } from "./stdio-launch.ts";
import type { McpLocalState } from "./local-state.ts";
import { McpError, type JsonObject, type McpCatalogItems, type McpCatalogKind, type McpCatalogs, type McpCapabilities,
	type McpDiagnostic, type McpRequestOptions, type McpServerDefinition, type McpToolDefinition, type McpToolResult, type McpResourceResult, type McpPromptResult } from "./types.ts";
import { abortable, deadline, diagnostic, freeze, MCP_LIMITS, safeText, throwCancelled } from "./util.ts";

const kinds = ["tools", "resources", "templates", "prompts"] as const;
const { name, version } = createRequire(import.meta.url)("../../package.json") as { name: string; version: string };
/** Per-page requests bypass the SDK's aggregate-list gate for SEP-2243. Apply its constraints before publishing tools. */
function validHeaderDeclarations(schema: JsonObject): boolean {
	const names = new Set<string>();
	const branches = new Set(["items", "prefixItems", "contains", "additionalProperties", "unevaluatedProperties", "unevaluatedItems", "propertyNames", "oneOf", "anyOf", "allOf", "not", "if", "then", "else"]);
	const maps = new Set(["patternProperties", "dependentSchemas", "$defs", "definitions"]);
	const visit = (value: unknown, reachable: boolean, root = false): boolean => {
		if (!value || typeof value !== "object" || Array.isArray(value)) return true;
		const node = value as Record<string, unknown>;
		if (Object.hasOwn(node, "x-mcp-header")) {
			const name = node["x-mcp-header"];
			if (!reachable || root || typeof name !== "string" || !/^[!#$%&'*+.^_`|~0-9a-z-]+$/i.test(name)
				|| !["string", "integer", "boolean"].includes(String(node.type)) || names.has(name.toLowerCase())) return false;
			names.add(name.toLowerCase());
		}
		for (const [key, child] of Object.entries(node)) {
			if (key === "properties" || maps.has(key)) { if (child && typeof child === "object" && !Object.values(child).every(item => visit(item, key === "properties" && reachable))) return false; }
			else if (branches.has(key) && !(Array.isArray(child) ? child : [child]).every(item => visit(item, false))) return false;
		}
		return true;
	};
	return visit(schema, true, true);
}
function failure(error: unknown, signal?: AbortSignal): McpError {
	if (signal?.aborted) return signal.reason instanceof McpError ? signal.reason : new McpError("cancelled", "MCP 操作已取消。");
	if (error instanceof McpError) return error;
	if (error instanceof Error && error.cause instanceof McpError) return error.cause;
	if (error instanceof UnauthorizedError || error instanceof InsufficientScopeError ||
		(error instanceof SdkHttpError && (error.data.status === 401 || error.data.status === 403)))
		return new McpError("needs-auth", "MCP 需要登录或更新认证配置。");
	if (error instanceof MissingRequiredClientCapabilityError) return new McpError("unsupported", "MCP 不支持请求所需的能力。");
	if (error instanceof ProtocolError) return new McpError("protocol", `MCP 协议请求失败（${error.code}）。`);
	if (error instanceof SdkError) {
		if (error.code === SdkErrorCode.ClientHttpAuthentication || error.code === SdkErrorCode.ClientHttpForbidden) return new McpError("needs-auth", "MCP 需要登录或更新认证配置。");
		if (error.code === SdkErrorCode.RequestTimeout) return new McpError("timeout", "MCP 操作超时。");
		if (error.code === SdkErrorCode.CapabilityNotSupported) return new McpError("unsupported", "MCP 不支持请求所需的能力。");
		if (error.code === SdkErrorCode.InvalidResult) return new McpError("protocol", "MCP 返回的协议数据无效。");
		if (error.code === SdkErrorCode.UnsupportedResultType || error.code === SdkErrorCode.InputRequiredRoundsExceeded || error.code === SdkErrorCode.MethodNotSupportedByProtocolVersion)
			return new McpError("unsupported", "MCP 不支持请求所需的能力。");
	}
	if (error instanceof Error && /^ReadBuffer exceeded maximum size of \d+ bytes$/.test(error.message)) return new McpError("limit", "MCP stdio 消息超过接收上限。");
	return new McpError("transport", "MCP 连接或请求失败，请检查服务器配置。");
}

/** The only layer allowed to own SDK clients/transports. */
export class McpConnection {
	private readonly lifetime = new AbortController();
	private readonly client: Client;
	private readonly catalogs: { [K in McpCatalogKind]: McpCatalog<K> };
	private readonly refreshTimers = new Map<McpCatalogKind, ReturnType<typeof setTimeout>>();
	private transport?: StdioClientTransport | StreamableHTTPClientTransport;
	private closing?: Promise<void>;
	private subscription?: McpSubscription;
	private sdkConnecting?: Promise<void>;
	private secrets: string[] = [];
	private stderrTail = "";
	ready = false;
	error?: McpDiagnostic;
	capabilities: McpCapabilities = { tools: false, resources: false, prompts: false };
	constructor(readonly definition: McpServerDefinition, readonly generation: number, private readonly cwd: string,
		private readonly local: McpLocalState, private readonly publish: () => void) {
		this.catalogs = { tools: new McpCatalog("tools", publish), resources: new McpCatalog("resources", publish), templates: new McpCatalog("templates", publish), prompts: new McpCatalog("prompts", publish) };
		const handler = (kind: McpCatalogKind) => ({ autoRefresh: false, debounceMs: 0, onChanged: () => this.changed(kind) });
		this.client = new Client({ name, version }, {
			capabilities: { roots: {} }, enforceStrictCapabilities: true,
			versionNegotiation: { mode: "auto", probe: { timeoutMs: definition.config.type === "stdio" && process.platform === "win32" ? 5000 : MCP_LIMITS.probeMs, maxRetries: 0 } },
			inputRequired: { autoFulfill: true, maxRounds: 3 },
			listChanged: { tools: handler("tools"), resources: handler("resources"), prompts: handler("prompts") }, listMaxPages: MCP_LIMITS.catalogPages,
		});
		this.client.setRequestHandler("roots/list", () => ({ roots: [{ uri: pathToFileURL(this.cwd).href, name: "project" }] }));
		this.client.onclose = () => {
			this.ready = false;
			if (!this.lifetime.signal.aborted) {
				this.error = this.error?.code === "limit" ? this.error : { code: "transport", message: "MCP 连接已断开，请重连。" };
				this.lifetime.abort(new McpError(this.error.code, this.error.message));
			}
			for (const catalog of Object.values(this.catalogs)) catalog.close();
			this.publish();
		};
		this.client.onerror = error => { if (!this.lifetime.signal.aborted) { this.error = diagnostic(failure(error)); this.publish(); } };
	}
	get stderr() { return this.stderrTail; }
	get protocolVersion() { return this.client.getNegotiatedProtocolVersion(); }
	get protocolEra() { return this.client.getProtocolEra(); }
	get serverInfo() { return this.client.getServerVersion(); }
	get instructions() { return this.client.getInstructions(); }
	getCatalogs(): McpCatalogs { return Object.fromEntries(kinds.map(kind => [kind, this.catalogs[kind].getSnapshot()])) as McpCatalogs; }
	async connect(signal?: AbortSignal): Promise<void> {
		const config = this.definition.config, budget = deadline(config.startupTimeoutMs, signal, this.lifetime.signal);
		try {
			throwCancelled(budget.signal);
			if (config.type === "stdio") {
				const env = { ...Object.fromEntries(config.envVars.map(name => [name, requiredEnv(name)])), ...config.env };
				this.secrets = Object.values(env);
				const transport = new StdioClientTransport({ ...stdioLaunch(config.command, config.args, env), cwd: config.cwd,
					stderr: "pipe", maxBufferSize: MCP_LIMITS.messageBytes });
				transport.stderr?.on("data", (chunk: Buffer) => {
					this.stderrTail = Buffer.from(safeText(this.stderrTail + chunk.toString("utf8"), this.secrets)).subarray(-MCP_LIMITS.stderrBytes).toString("utf8");
				});
				this.transport = transport;
			} else {
				const headers = new Headers(config.headers);
				for (const [name, variable] of Object.entries(config.envHeaders)) headers.set(name, requiredEnv(variable));
				if (config.auth.type === "bearer") headers.set("Authorization", `Bearer ${requiredEnv(config.auth.tokenEnv)}`);
				headers.forEach(value => this.secrets.push(value));
				this.transport = new StreamableHTTPClientTransport(new URL(config.url), {
					requestInit: { headers }, fetch: boundedFetch(this.lifetime.signal, fetch, config.requestTimeoutMs), onInsufficientScope: "throw",
					...(config.auth.type === "oauth" ? { authProvider: new McpOAuthProvider(config.auth, credentialKey(config), this.local) } : {}),
				});
			}
			this.sdkConnecting = this.client.connect(this.transport, { signal: budget.signal, timeout: config.startupTimeoutMs });
			await abortable(this.sdkConnecting, budget.signal);
			throwCancelled(budget.signal);
			const caps = this.client.getServerCapabilities();
			this.capabilities = freeze({ tools: Boolean(caps?.tools), resources: Boolean(caps?.resources), prompts: Boolean(caps?.prompts) });
			for (const kind of kinds) if (!this.supports(kind)) this.catalogs[kind].unsupported();
			this.ready = true; this.error = undefined; this.publish();
			this.subscription = this.client.autoOpenedSubscription;
			if (this.protocolEra === "modern" && (caps?.tools?.listChanged || caps?.resources?.listChanged || caps?.prompts?.listChanged) && !this.subscription)
				throw new McpError("protocol", "MCP 目录通知通道建立失败，请重连。");
			if (this.subscription) this.watchSubscription(this.subscription);
			if (this.capabilities.tools) await this.list("tools", { signal: budget.signal }).catch(error => { throwCancelled(budget.signal); this.error = diagnostic(error); });
			if (!this.ready) {
				const error = this.error as McpDiagnostic | undefined;
				throw new McpError(error?.code ?? "transport", error?.message ?? "MCP 连接已断开，请重连。");
			}
		} catch (error) { const mapped = failure(error, budget.signal); this.error = diagnostic(mapped); await this.close(); throw mapped; }
		finally { budget.dispose(); this.publish(); }
	}
	private watchSubscription(subscription: McpSubscription) {
		void subscription.closed.then(async reason => {
			if (this.lifetime.signal.aborted || reason === "local") return;
			// Missing notifications makes consumed catalogs unsafe. Require an explicit reconnect.
			this.error = { code: "transport", message: "MCP 目录通知连接已断开，请重连。" };
			for (const catalog of Object.values(this.catalogs)) catalog.invalidate();
			await this.close(); this.publish();
		});
	}
	private supports(kind: McpCatalogKind) { return this.capabilities[kind === "templates" ? "resources" : kind]; }
	private changed(kind: McpCatalogKind) {
		const affected: McpCatalogKind[] = kind === "resources" ? ["resources", "templates"] : [kind];
		for (const key of affected) {
			const loaded = this.catalogs[key].getSnapshot().status !== "unloaded";
			this.catalogs[key].invalidate();
			if (loaded && !this.refreshTimers.has(key) && !this.lifetime.signal.aborted) {
				const timer = setTimeout(() => { this.refreshTimers.delete(key); if (this.ready) void this.list(key).catch(() => {}); }, 200);
				timer.unref(); this.refreshTimers.set(key, timer);
			}
		}
	}
	private async request<T>(options: McpRequestOptions | undefined, run: (options: RequestOptions) => Promise<T>): Promise<T> {
		if (!this.ready) throw new McpError("binding-invalid", "MCP 连接已失效，请重新获取连接。");
		const budget = deadline(options?.timeoutMs ?? this.definition.config.requestTimeoutMs, options?.signal, this.lifetime.signal);
		try {
			throwCancelled(budget.signal);
			const value = await abortable(run({ signal: budget.signal, timeout: options?.timeoutMs ?? this.definition.config.requestTimeoutMs,
				onprogress: options?.onProgress ? progress => options.onProgress?.({ ...progress, ...(progress.message ? { message: safeText(progress.message, this.secrets) } : {}) }) : undefined }), budget.signal);
			throwCancelled(budget.signal);
			if (Buffer.byteLength(JSON.stringify(value)) > MCP_LIMITS.messageBytes) throw new McpError("limit", "MCP 返回结果超过接收上限。");
			return freeze(structuredClone(value));
		} catch (error) {
			const mapped = failure(error, budget.signal);
			if (mapped.code === "needs-auth") { this.error = diagnostic(mapped); await this.close(); }
			throw mapped;
		} finally { budget.dispose(); }
	}
	async list<K extends McpCatalogKind>(kind: K, options?: McpRequestOptions): Promise<readonly McpCatalogItems[K][]> {
		if (!this.supports(kind)) throw new McpError("unsupported", "MCP 服务器不支持该目录。");
		const budget = deadline(options?.timeoutMs ?? this.definition.config.requestTimeoutMs, options?.signal, this.lifetime.signal);
		try {
			return await this.catalogs[kind].load(async (cursor, signal) => this.request({ signal }, async requestOptions => {
				const params = cursor === undefined ? {} : { cursor };
				const result = kind === "tools" ? await this.client.request({ method: "tools/list", params }, requestOptions)
					: kind === "resources" ? await this.client.request({ method: "resources/list", params }, requestOptions)
					: kind === "templates" ? await this.client.request({ method: "resources/templates/list", params }, requestOptions)
					: await this.client.request({ method: "prompts/list", params }, requestOptions);
				let items = ("tools" in result ? result.tools : "resources" in result ? result.resources : "resourceTemplates" in result ? result.resourceTemplates : result.prompts) as unknown as McpCatalogItems[K][];
				if (kind === "tools" && this.protocolEra === "modern" && this.definition.config.type === "http") {
					const filtered = items.filter(tool => "inputSchema" in tool && validHeaderDeclarations(tool.inputSchema));
					if (filtered.length !== items.length) { this.error = { code: "protocol", message: "MCP 已排除含无效请求头映射的工具定义。" }; this.publish(); }
					items = filtered;
				}
				return { items: items as unknown as McpCatalogItems[K][], nextCursor: result.nextCursor };
			}), budget.signal);
		} finally { budget.dispose(); }
	}
	callTool(tool: McpToolDefinition, args: JsonObject, options?: McpRequestOptions) {
		return this.request(options, requestOptions => this.client.callTool({ name: tool.name, arguments: args }, { ...requestOptions, toolDefinition: tool as Tool })) as Promise<McpToolResult>;
	}
	readResource(uri: string, options?: McpRequestOptions) { return this.request(options, opts => this.client.readResource({ uri }, opts)) as Promise<McpResourceResult>; }
	getPrompt(name: string, args: Record<string, string>, options?: McpRequestOptions) { return this.request(options, opts => this.client.getPrompt({ name, arguments: args }, opts)) as Promise<McpPromptResult>; }
	close(): Promise<void> {
		if (this.closing) return this.closing;
		this.ready = false; this.lifetime.abort(new McpError(this.error?.code ?? "closed", this.error?.message ?? "MCP 已关闭。"));
		for (const timer of this.refreshTimers.values()) clearTimeout(timer);
		this.refreshTimers.clear(); for (const catalog of Object.values(this.catalogs)) catalog.close();
		this.closing = (async () => {
			const budget = deadline(MCP_LIMITS.cleanupMs);
			try {
				// During stdio version negotiation the SDK's disposable probe is
				// cancelled through the session transport, before Client owns it.
				if (this.transport instanceof StdioClientTransport && !this.client.transport)
					await abortable(this.transport.close(), budget.signal);
				await abortable(this.client.close(), budget.signal);
				await abortable(this.sdkConnecting?.catch(() => {}) ?? Promise.resolve(), budget.signal);
				await abortable(this.client.close(), budget.signal);
			}
			catch { this.error ??= { code: "transport", message: "MCP 连接清理未正常完成。" }; }
			finally { budget.dispose(); this.publish(); }
		})();
		return this.closing;
	}
}
