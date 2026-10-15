import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Type, type Static } from "typebox";
import { Check, Errors } from "typebox/value";
import type { Model, ThinkingPreferences } from "../types.ts";

const NonemptyString = Type.String({ pattern: "\\S" });
const PositiveInteger = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const ConnectionSchema = Type.Object({
	api: Type.Union([
		Type.Literal("openai-completions"), Type.Literal("openai-responses"), Type.Literal("anthropic-messages"),
	]),
	baseUrl: NonemptyString,
	endpoint: Type.Optional(NonemptyString),
	apiKey: Type.Optional(NonemptyString),
	apiKeyEnv: Type.Optional(Type.String({ pattern: "^[A-Za-z_][A-Za-z0-9_]*$" })),
}, { additionalProperties: false });
const ModelSchema = Type.Object({
	connection: NonemptyString,
	id: NonemptyString,
	name: Type.Optional(NonemptyString),
	contextWindow: PositiveInteger,
	maxOutputTokens: Type.Optional(PositiveInteger),
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
	/** Credentials stay out of models, messages and session data. Only resolve the requested model's key. */
	getApiKey(model?: string): string;
}

/** Read the BYOK catalog, validate every entry, then select the current model. */
export function loadByokConfig(options: LoadByokConfigOptions = {}): LoadedByokConfig {
	const cwd = resolve(options.cwd ?? process.cwd());
	const env = options.env ?? process.env;
	const explicitPath = options.configPath ?? env.CLI_AGENT_CONFIG;
	if (explicitPath !== undefined && !explicitPath.trim()) throw new Error("BYOK 配置路径不能为空。");
	const configPath = resolve(cwd, explicitPath ?? "byok.json");
	let text: string;
	try {
		text = readFileSync(configPath, "utf8");
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") {
			throw new Error(`缺少 BYOK 配置 ${configPath}。请复制 byok.example.json 到该位置并填写模型，或用 CLI_AGENT_CONFIG 指定文件。`);
		}
		throw new Error(`无法读取 BYOK 配置 ${configPath}（${code ?? "读取失败"}）。`);
	}

	let raw: unknown;
	try {
		raw = JSON.parse(text.replace(/^\uFEFF/, ""));
	} catch {
		// JSON.parse errors can quote a key from the input. Never include their raw message.
		throw new Error(`BYOK 配置 ${configPath} 不是有效的 JSON。`);
	}
	if (!Check(ConfigSchema, raw)) {
		const error = Errors(ConfigSchema, raw)[0];
		throw new Error(`BYOK 配置 ${configPath} 字段无效：${error?.instancePath || "/"}（${error?.keyword ?? "schema"}）。`);
	}
	const config: Static<typeof ConfigSchema> = raw;
	for (const [key, connection] of Object.entries(config.connections)) {
		if ((connection.apiKey === undefined) === (connection.apiKeyEnv === undefined)) {
			throw new Error(`连接 ${key} 必须且只能设置 apiKey 或 apiKeyEnv 之一。`);
		}
		connection.baseUrl = validateUrl(connection.baseUrl, `connections/${key}/baseUrl`, false);
		if (connection.endpoint !== undefined) {
			connection.endpoint = validateUrl(connection.endpoint, `connections/${key}/endpoint`, true);
		}
	}
	const models: Record<string, Model> = Object.create(null);
	for (const [key, entry] of Object.entries(config.models)) {
		if (!Object.hasOwn(config.connections, entry.connection)) {
			throw new Error(`模型 ${key} 引用了不存在的连接 ${entry.connection}。`);
		}
		if (entry.maxOutputTokens !== undefined && entry.maxOutputTokens > entry.contextWindow) {
			throw new Error(`模型 ${key} 的 maxOutputTokens 不能超过 contextWindow。`);
		}
		const connection = config.connections[entry.connection];
		models[key] = {
			id: entry.id.trim(), name: entry.name?.trim() ?? entry.id.trim(),
			provider: entry.connection, api: connection.api, baseUrl: connection.baseUrl,
			contextWindow: entry.contextWindow,
			...(connection.endpoint !== undefined ? { endpoint: connection.endpoint } : {}),
			...(entry.maxOutputTokens !== undefined ? { maxOutputTokens: entry.maxOutputTokens } : {}),
			...(entry.capabilities !== undefined ? { capabilities: { ...entry.capabilities } } : {}),
		};
	}
	// A runtime selection cannot conceal a broken saved selection.
	if (!Object.hasOwn(models, config.currentModel)) throw new Error(`currentModel 引用了不存在的模型 ${config.currentModel}。`);
	const currentModel = options.model ?? config.currentModel;
	if (!Object.hasOwn(models, currentModel)) throw new Error(`未找到 BYOK 模型 ${currentModel}。`);
	return {
		configPath, models, currentModel, model: structuredClone(models[currentModel]),
		thinking: { ...config.thinking, effort: config.thinking?.effort ?? "medium" },
		getApiKey(modelKey = currentModel) {
			if (!Object.hasOwn(config.models, modelKey)) throw new Error(`未找到 BYOK 模型 ${modelKey}。`);
			const connection = config.connections[config.models[modelKey].connection];
			const apiKey = (connection.apiKeyEnv !== undefined ? env[connection.apiKeyEnv] : connection.apiKey)?.trim();
			if (!apiKey) throw new Error(`模型 ${modelKey} 缺少凭据${connection.apiKeyEnv ? `：请设置环境变量 ${connection.apiKeyEnv}` : ""}。`);
			return apiKey;
		},
	};
}

function validateUrl(raw: string, field: string, endpoint: boolean): string {
	let url: URL;
	try { url = new URL(raw.trim()); } catch { throw new Error(`BYOK ${field} 必须是绝对 HTTP(S) URL。`); }
	if (!/^https?:\/\//i.test(raw.trim()) || !["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash) {
		throw new Error(`BYOK ${field} 必须是 HTTP(S) URL，且不能包含凭据、查询参数或片段。`);
	}
	if (!endpoint && /\/(chat\/completions|responses|messages)\/*$/.test(url.pathname)) {
		throw new Error(`BYOK ${field} 是完整推理地址；请将它填入 endpoint，并用 baseUrl 保存基础地址。`);
	}
	return endpoint ? raw.trim() : raw.trim().replace(/\/+$/, "");
}
