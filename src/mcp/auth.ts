import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { auth, type OAuthClientProvider, type OAuthClientInformationContext, type OAuthClientMetadata,
	type OAuthDiscoveryState, type StoredOAuthClientInformation, type StoredOAuthTokens } from "@modelcontextprotocol/client";
import { McpError, type JsonValue, type McpServerConfig } from "./types.ts";
import { McpLocalState } from "./local-state.ts";
import { abortable, deadline, digest, MCP_LIMITS, throwCancelled } from "./util.ts";
import { boundedFetch } from "./http.ts";

type HttpConfig = Extract<McpServerConfig, { type: "http" }>;
type OAuthConfig = Extract<HttpConfig["auth"], { type: "oauth" }>;
export function credentialKey(config: HttpConfig): string { return digest({ url: config.url, auth: config.auth }); }
export function requiredEnv(name: string): string {
	const value = process.env[name];
	if (!value) throw new McpError("needs-auth", `MCP 所需环境变量 ${name} 未设置。`);
	return value;
}

/** SDK handles discovery, registration, PKCE, issuer checking and refresh. Interactive consent is explicit. */
export class McpOAuthProvider implements OAuthClientProvider {
	private redirect?: string;
	private verifier?: string;
	private readonly nonce = randomBytes(32).toString("base64url");
	private authorize?: (url: URL) => void;
	constructor(private readonly config: OAuthConfig, readonly key: string, private readonly local: McpLocalState) {}
	private data() { return this.local.getCredentials(this.key)?.data ?? {}; }
	private save(key: string, value: unknown) {
		this.local.updateCredentials(this.key, data => ({ ...data, [key]: JSON.parse(JSON.stringify(value)) as JsonValue }));
	}
	get redirectUrl() { return this.redirect ?? this.data().redirectUrl as string | undefined ?? `http://127.0.0.1:${this.config.callbackPort ?? 0}/callback`; }
	get clientMetadata(): OAuthClientMetadata {
		return { client_name: "ResidualX", redirect_uris: [this.redirectUrl], grant_types: ["authorization_code", "refresh_token"],
			response_types: ["code"], token_endpoint_auth_method: this.config.clientSecretEnv ? "client_secret_post" : "none",
			...(this.config.scopes?.length ? { scope: this.config.scopes.join(" ") } : {}) };
	}
	state() { return this.nonce; }
	clientInformation(ctx?: OAuthClientInformationContext): StoredOAuthClientInformation | undefined {
		if (this.config.clientId) return { client_id: this.config.clientId,
			...(ctx?.issuer ? { issuer: ctx.issuer } : {}),
			...(this.config.clientSecretEnv ? { client_secret: requiredEnv(this.config.clientSecretEnv) } : {}) };
		const value = this.data().client as StoredOAuthClientInformation | undefined;
		return value && (!ctx?.issuer || value.issuer === ctx.issuer) ? value : undefined;
	}
	saveClientInformation(value: StoredOAuthClientInformation) { this.save("client", value); }
	tokens(ctx?: OAuthClientInformationContext): StoredOAuthTokens | undefined {
		const value = this.data().tokens as StoredOAuthTokens | undefined;
		return value && (!ctx?.issuer || value.issuer === ctx.issuer) ? value : undefined;
	}
	saveTokens(value: StoredOAuthTokens) { this.save("tokens", value); this.save("redirectUrl", this.redirectUrl); }
	redirectToAuthorization(url: URL) {
		if (!this.authorize) throw new McpError("needs-auth", "MCP 需要登录，请使用 /mcp login。");
		this.authorize(url);
	}
	saveCodeVerifier(value: string) { this.verifier = value; }
	codeVerifier() { if (!this.verifier) throw new McpError("needs-auth", "MCP 登录验证已过期，请重新登录。"); return this.verifier; }
	discoveryState(): OAuthDiscoveryState | undefined { return this.data().discovery as unknown as OAuthDiscoveryState | undefined; }
	saveDiscoveryState(value: OAuthDiscoveryState) { this.save("discovery", value); }
	invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery") {
		if (scope === "verifier" || scope === "all") this.verifier = undefined;
		this.local.updateCredentials(this.key, data => {
			if (scope === "all") return {};
			const next = { ...data }; delete next[scope]; return next;
		});
	}
	async login(url: string, showUrl: (url: string) => void, signal?: AbortSignal): Promise<void> {
		const budget = deadline(MCP_LIMITS.loginMs, signal);
		let resolveCallback!: (value: { code: string; iss?: string }) => void;
		let rejectCallback!: (reason: unknown) => void;
		const callback = new Promise<{ code: string; iss?: string }>((resolve, reject) => { resolveCallback = resolve; rejectCallback = reject; });
		void callback.catch(() => {});
		let consumed = false;
		const server = createServer((request, response) => {
			const result = new URL(request.url ?? "/", this.redirectUrl);
			if (request.method !== "GET" || result.pathname !== "/callback" || result.searchParams.get("state") !== this.nonce || consumed) {
				response.writeHead(400).end("Invalid authorization callback."); return;
			}
			consumed = true;
			const code = result.searchParams.get("code");
			response.writeHead(200, { "Content-Type": "text/plain", "Cache-Control": "no-store" }).end("Return to ResidualX to continue.");
			if (!code || result.searchParams.has("error")) rejectCallback(new McpError("needs-auth", "MCP 登录未获授权。"));
			else resolveCallback({ code, ...(result.searchParams.get("iss") ? { iss: result.searchParams.get("iss")! } : {}) });
		});
		server.requestTimeout = 10000; server.headersTimeout = 10000;
		try {
			throwCancelled(budget.signal);
			await abortable(new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen({ port: this.config.callbackPort ?? 0, host: "127.0.0.1", signal: budget.signal }, resolve); }), budget.signal);
			const address = server.address();
			if (!address || typeof address === "string") throw new McpError("transport", "MCP 登录回调无法启动。");
			this.redirect = `http://127.0.0.1:${address.port}/callback`;
			// A dynamic registration is tied to its exact redirect URI. An ephemeral port needs a new registration.
			if (!this.config.clientId && this.data().redirectUrl !== this.redirect) this.invalidateCredentials("client");
			this.authorize = destination => showUrl(destination.href);
			const fetchFn = boundedFetch(budget.signal);
			const result = await abortable(auth(this, { serverUrl: url, fetchFn, scope: this.config.scopes?.join(" "), forceReauthorization: true }), budget.signal);
			if (result === "REDIRECT") {
				const response = await abortable(callback, budget.signal);
				await abortable(auth(this, { serverUrl: url, authorizationCode: response.code, iss: response.iss, fetchFn }), budget.signal);
			}
			throwCancelled(budget.signal);
			this.local.updateCredentials(this.key, data => data, true);
		} catch (error) {
			throwCancelled(budget.signal);
			if (error instanceof McpError) throw error;
			throw new McpError("needs-auth", "MCP 登录失败，请检查 OAuth 服务和客户端配置。");
		} finally {
			this.authorize = undefined; this.verifier = undefined; budget.dispose();
			server.closeAllConnections();
			await new Promise<void>(resolve => server.close(() => resolve()));
		}
	}
}
