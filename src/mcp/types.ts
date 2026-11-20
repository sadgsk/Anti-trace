/** MCP's public contracts contain plain data only; SDK objects stay in the connection layer. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };
export type McpScope = "user" | "project";
export type McpAuth = { type: "none" } | { type: "bearer"; tokenEnv: string }
	| { type: "oauth"; clientId?: string; clientSecretEnv?: string; scopes?: string[]; callbackPort?: number };
export interface McpCommonConfig {
	enabled: boolean; startupTimeoutMs: number; requestTimeoutMs: number; outputMaxBytes: number;
	enabledTools?: string[]; disabledTools: string[];
}
export type McpServerConfig = McpCommonConfig & (
	{ type: "stdio"; command: string; args: string[]; cwd?: string; env: Record<string, string>; envVars: string[] }
	| { type: "http"; url: string; headers: Record<string, string>; envHeaders: Record<string, string>; auth: McpAuth }
);
export interface McpConfigDocument { version: 1; mcpServers: Record<string, McpServerConfig> }
export interface McpConfigSource { scope: McpScope; path: string }
export interface McpServerDefinition {
	id: string; config: McpServerConfig; source: McpConfigSource; overridden?: McpConfigSource;
	/** Normalized location and execution/access settings; timeouts and tool policy do not revoke trust. */
	trustKey: string; configKey: string;
}
export interface McpConfigCandidate {
	servers: McpServerDefinition[]; documents: Record<McpScope, McpConfigDocument>;
	digests: Record<McpScope, string>; paths: Record<McpScope, string>;
}
export type McpErrorCode = "config" | "untrusted" | "disabled" | "needs-auth" | "unsupported" | "cancelled"
	| "timeout" | "protocol" | "transport" | "limit" | "binding-invalid" | "catalog-changed" | "closed" | "busy";
export class McpError extends Error {
	constructor(readonly code: McpErrorCode, message: string) { super(message); this.name = "McpError"; }
}
export interface McpDiagnostic { code: McpErrorCode; message: string }
export type McpServerStatus = "disabled" | "untrusted" | "disconnected" | "connecting" | "ready" | "needs-auth" | "failed" | "closing";
export type McpCatalogKind = "tools" | "resources" | "templates" | "prompts";
export interface McpToolDefinition { name: string; title?: string; description?: string; inputSchema: JsonObject; outputSchema?: JsonObject; annotations?: JsonObject; execution?: { taskSupport?: "required" | "optional" | "forbidden" }; _meta?: JsonObject }
export interface McpResourceDefinition { name: string; uri: string; title?: string; description?: string; mimeType?: string; size?: number; annotations?: JsonObject; _meta?: JsonObject }
export interface McpResourceTemplate { name: string; uriTemplate: string; title?: string; description?: string; mimeType?: string; annotations?: JsonObject; _meta?: JsonObject }
export interface McpPromptDefinition { name: string; title?: string; description?: string; arguments?: { name: string; description?: string; required?: boolean }[]; _meta?: JsonObject }
export interface McpCatalogItems { tools: McpToolDefinition; resources: McpResourceDefinition; templates: McpResourceTemplate; prompts: McpPromptDefinition }
export interface McpCatalogSnapshot<T> {
	status: "unloaded" | "loading" | "ready" | "stale" | "failed" | "unsupported";
	revision: number; items: readonly T[]; error?: McpDiagnostic;
}
export type McpCatalogs = { [K in McpCatalogKind]: McpCatalogSnapshot<McpCatalogItems[K]> };
export interface McpCapabilities { tools: boolean; resources: boolean; prompts: boolean }
export interface McpServerSnapshot {
	id: string; type: "stdio" | "http"; source: McpConfigSource; overridden?: McpConfigSource;
	status: McpServerStatus; enabled: boolean; trusted: boolean; generation: number;
	protocolVersion?: string; protocolEra?: "legacy" | "modern"; serverName?: string; serverVersion?: string;
	capabilities: McpCapabilities; catalogs: McpCatalogs; error?: McpDiagnostic; stderr: string;
}
export interface McpRuntimeSnapshot { servers: readonly McpServerSnapshot[]; diagnostics: readonly McpDiagnostic[]; closed: boolean }
export interface McpRequestOptions { signal?: AbortSignal; timeoutMs?: number; onProgress?: (progress: { progress: number; total?: number; message?: string }) => void }
export type McpResourceContent = { uri: string; mimeType?: string; _meta?: JsonObject } & ({ text: string } | { blob: string });
export type McpContent = ({ type: "text"; text: string } | { type: "image" | "audio"; data: string; mimeType: string }
	| ({ type: "resource_link" } & McpResourceDefinition) | { type: "resource"; resource: McpResourceContent }) & { annotations?: JsonObject; _meta?: JsonObject };
export interface McpToolResult { content: McpContent[]; structuredContent?: JsonValue; isError?: boolean; _meta?: JsonObject }
export interface McpResourceResult { contents: McpResourceContent[]; _meta?: JsonObject }
export interface McpPromptResult { description?: string; messages: { role: "user" | "assistant"; content: McpContent }[]; _meta?: JsonObject }
export interface McpServerBinding {
	readonly serverId: string; readonly generation: number; readonly identity: string; readonly toolRevision: number;
	readonly capabilities: Readonly<McpCapabilities>; readonly tools: readonly McpToolDefinition[];
	readonly instructions?: string; readonly outputMaxBytes: number;
}
export interface McpBinding {
	readonly servers: ReadonlyMap<string, McpServerBinding>;
	listTools(serverId: string, options?: McpRequestOptions): Promise<readonly McpToolDefinition[]>;
	callTool(serverId: string, name: string, args: JsonObject, options?: McpRequestOptions): Promise<McpToolResult>;
	listResources(serverId: string, options?: McpRequestOptions): Promise<readonly McpResourceDefinition[]>;
	listResourceTemplates(serverId: string, options?: McpRequestOptions): Promise<readonly McpResourceTemplate[]>;
	readResource(serverId: string, uri: string, options?: McpRequestOptions): Promise<McpResourceResult>;
	listPrompts(serverId: string, options?: McpRequestOptions): Promise<readonly McpPromptDefinition[]>;
	getPrompt(serverId: string, name: string, args: Record<string, string>, options?: McpRequestOptions): Promise<McpPromptResult>;
	release(): void;
}
