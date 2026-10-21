import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Type, type Static } from "typebox";
import { Check, Errors } from "typebox/value";
import type { Model, ThinkingPreferences } from "../types.ts";
import { AdapterConfigSchema, validateAdapterConfig, validateAdapterForApi } from "../llm/rules.ts";
import { ByokConfigError } from "./errors.ts";
import { CONNECTION_PRESETS } from "./presets.ts";

const NonemptyString = Type.String({ pattern: "\\S" });
const PositiveInteger = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const ConnectionSchema = Type.Object({
	preset: Type.Optional(Type.String()),
	api: Type.Optional(Type.Union([
		Type.Literal("openai-completions"), Type.Literal("openai-responses"), Type.Literal("anthropic-messages"),
	])),
	baseUrl: Type.Optional(NonemptyString),
	endpoint: Type.Optional(NonemptyString),
	apiKey: Type.Optional(NonemptyString),
	apiKeyEnv: Type.Optional(Type.String({ pattern: "^[A-Za-z_][A-Za-z0-9_]*$" })),
	adapter: Type.Optional(AdapterConfigSchema),
}, { additionalProperties: false });
const ModelSchema = Type.Object({
	connection: NonemptyString,
	id: NonemptyString,
	name: Type.Optional(NonemptyString),
	contextWindow: PositiveInteger,
	maxOutputTokens: Type.Optional(PositiveInteger),
	adapter: Type.Optional(AdapterConfigSchema),
	capabilities: Type.Optional(Type.Object({
		images: Type.Optional(Type.Boolean()),
		tools: Type.Optional(Type.Boolean()),
		thinking: Type.Optional(Type.Boolean()),
	}, { additionalProperties: false })),
}, { additionalProperties: false });
const ConfigSchema = Type.Object({
	version: Type.Literal(1),
	connections: Type.Record(Type.String(), ConnectionSchema, { minProperties: 1 }),
	models: Type.Record(Type.String(), ModelSchema, { minProperties: 1 }),
	currentModel: NonemptyString,
	thinking: Type.Optional(Type.Object({
		enabled: Type.Optional(Type.Boolean()),
		effort: Type.Optional(Type.Union([
			Type.Literal("low"), Type.Literal("medium"), Type.Literal("high"), Type.Literal("xhigh"), Type.Literal("max"),
		])),
	}, { additionalProperties: false })),
}, { additionalProperties: false });

export interface LoadByokConfigOptions {
	cwd?: string;
	configPath?: string;
	/** Model catalog key; takes precedence over currentModel in the file. */
	model?: string;
	env?: NodeJS.ProcessEnv;
}

export interface LoadedByokConfig {
	configPath: string;
	models: Record<string, Model>;
	currentModel: string;
	model: Model;
	thinking: ThinkingPreferences;
	warnings: string[];
	/** Credentials stay out of models, messages and session data. Only resolve the requested model's key. */
	getApiKey(model?: string | Model): string;
}

/** Read the BYOK catalog, validate every entry, then select the current model. */
export function loadByokConfig(options: LoadByokConfigOptions = {}): LoadedByokConfig {
	const cwd = resolve(options.cwd ?? process.cwd());
	const env = options.env ?? process.env;
	const explicitPath = options.configPath ?? env.CLI_AGENT_CONFIG;
	if (explicitPath !== undefined && !explicitPath.trim()) throw new ByokConfigError("BYOK 配置路径不能为空。");
	const configPath = resolve(cwd, explicitPath ?? "byok.json");
	let text: string;
	try {
		text = readFileSync(configPath, "utf8");
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") {
			throw new ByokConfigError(`缺少 BYOK 配置 ${configPath}。请复制 byok.example.json 到该位置并填写模型，或用 CLI_AGENT_CONFIG 指定文件。`);
		}
		throw new ByokConfigError(`无法读取 BYOK 配置 ${configPath}（${code ?? "读取失败"}）。`);
	}

	let raw: unknown;
	try {
		raw = JSON.parse(text.replace(/^\uFEFF/, ""));
	} catch {
		// JSON.parse errors can quote a key from the input. Never include their raw message.
		throw new ByokConfigError(`BYOK 配置 ${configPath} 不是有效的 JSON。`);
	}
	if (!Check(ConfigSchema, raw)) {
		const error = Errors(ConfigSchema, raw)[0];
		throw new ByokConfigError(`BYOK 配置 ${configPath} 字段无效：${error?.instancePath || "/"}（${error?.keyword ?? "schema"}）。`);
	}
	const config: Static<typeof ConfigSchema> = raw;
	const connections: Record<string, { api: Model["api"]; baseUrl: string; endpoint?: string; adapter?: Model["adapter"]; apiKey?: string; apiKeyEnv?: string }> = Object.create(null);
	for (const [key, connection] of Object.entries(config.connections)) {
		if (connection.preset !== undefined && !Object.hasOwn(CONNECTION_PRESETS, connection.preset)) {
			throw new ByokConfigError(`连接 ${key} 的 preset 未知。可选：${Object.keys(CONNECTION_PRESETS).join("、")}`);
		}
		const preset = connection.preset ? CONNECTION_PRESETS[connection.preset as keyof typeof CONNECTION_PRESETS] : undefined;
		const api = connection.api ?? preset?.api;
		const baseUrl = connection.baseUrl ?? preset?.baseUrl;
		if (!api || !baseUrl) throw new ByokConfigError(`连接 ${key} 需要 api 和 baseUrl，或明确选择连接 preset。`);
		const adapter = preset || connection.adapter ? { ...preset?.adapter, ...connection.adapter } : undefined;
		if ((connection.apiKey === undefined) === (connection.apiKeyEnv === undefined)) {
			throw new ByokConfigError(`连接 ${key} 必须且只能设置 apiKey 或 apiKeyEnv 之一。`);
		}
		if (adapter) {
			validateAdapterAt(adapter, `connections/${key}/adapter`);
			validateAdapterForApi(adapter, api);
		}
		connections[key] = { ...connection, api, adapter, baseUrl: validateUrl(baseUrl, `connections/${key}/baseUrl`, false) };
		if (connection.endpoint !== undefined) {
			connections[key]!.endpoint = validateUrl(connection.endpoint, `connections/${key}/endpoint`, true);
		}
	}
	const models: Record<string, Model> = Object.create(null);
	for (const [key, entry] of Object.entries(config.models)) {
		if (!Object.hasOwn(config.connections, entry.connection)) {
			throw new ByokConfigError(`模型 ${key} 引用了不存在的连接 ${entry.connection}。`);
		}
		if (entry.maxOutputTokens !== undefined && entry.maxOutputTokens > entry.contextWindow) {
			throw new ByokConfigError(`模型 ${key} 的 maxOutputTokens 不能超过 contextWindow。`);
		}
		const connection = connections[entry.connection]!;
		const adapter = connection.adapter || entry.adapter ? { ...connection.adapter, ...entry.adapter } : undefined;
		if (adapter) {
			validateAdapterAt(adapter, `models/${key}/adapter（合并连接默认值后）`);
			validateAdapterForApi(adapter, connection.api);
			if (entry.capabilities?.thinking === false && adapter.thinking && adapter.thinking.mode !== "unsupported") {
				throw new ByokConfigError(`模型 ${key} 的 thinking 能力与 adapter 规则冲突。`);
			}
		}
		models[key] = {
			id: entry.id.trim(), name: entry.name?.trim() ?? entry.id.trim(),
			provider: entry.connection, api: connection.api, baseUrl: connection.baseUrl,
			contextWindow: entry.contextWindow,
			...(connection.endpoint !== undefined ? { endpoint: connection.endpoint } : {}),
			...(entry.maxOutputTokens !== undefined ? { maxOutputTokens: entry.maxOutputTokens } : {}),
			...(entry.capabilities !== undefined ? { capabilities: { ...entry.capabilities } } : {}),
			...(adapter !== undefined ? { adapter: structuredClone(adapter) } : {}),
		};
	}
	const currentModel = options.model ?? config.currentModel;
	if (!Object.hasOwn(models, currentModel)) {
		throw new ByokConfigError(options.model === undefined
			? `currentModel 引用了不存在的模型 ${currentModel}。`
			: `未找到 BYOK 模型 ${currentModel}。`);
	}
	return {
		configPath, models, currentModel, model: structuredClone(models[currentModel]),
		thinking: { ...config.thinking, effort: config.thinking?.effort ?? "medium" },
		warnings: Object.hasOwn(models, config.currentModel) ? []
			: [`currentModel 引用了不存在的模型 ${config.currentModel}；本次使用明确选择的 ${currentModel}，请修正文件中的默认项。`],
		getApiKey(requested = currentModel) {
			const requestedModel = typeof requested === "string" ? models[requested] : requested;
			if (!requestedModel) throw new ByokConfigError(`未找到 BYOK 模型 ${requested}。`);
			const connection = connections[requestedModel.provider];
			if (!connection || connection.api !== requestedModel.api ||
				connection.baseUrl !== requestedModel.baseUrl || connection.endpoint !== requestedModel.endpoint) {
				throw new ByokConfigError("请求模型不属于当前连接目录，不能向其他接口发送该连接的凭据。");
			}
			const apiKey = (connection.apiKeyEnv !== undefined ? env[connection.apiKeyEnv] : connection.apiKey)?.trim();
			if (!apiKey) throw new ByokConfigError(`模型 ${requestedModel.id} 缺少凭据${connection.apiKeyEnv ? `：请设置环境变量 ${connection.apiKeyEnv}` : ""}。`);
			return apiKey;
		},
	};
}

function validateAdapterAt(value: unknown, field: string): void {
	try { validateAdapterConfig(value); }
	catch (error) {
		if (!(error instanceof ByokConfigError)) throw error;
		throw new ByokConfigError(`BYOK ${field}：${error.message}`);
	}
}

function validateUrl(raw: string, field: string, endpoint: boolean): string {
	let url: URL;
	try { url = new URL(raw.trim()); } catch { throw new ByokConfigError(`BYOK ${field} 必须是绝对 HTTP(S) URL。`); }
	if (!/^https?:\/\//i.test(raw.trim()) || !["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash) {
		throw new ByokConfigError(`BYOK ${field} 必须是 HTTP(S) URL，且不能包含凭据、查询参数或片段。`);
	}
	if (!endpoint && /\/(chat\/completions|responses|messages)\/*$/.test(url.pathname)) {
		throw new ByokConfigError(`BYOK ${field} 是完整推理地址；请将它填入 endpoint，并用 baseUrl 保存基础地址。`);
	}
	return endpoint ? raw.trim() : raw.trim().replace(/\/+$/, "");
}
