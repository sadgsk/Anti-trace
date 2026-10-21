import { ByokConfigError } from "../config/errors.ts";
import { Type, type Static } from "typebox";
import { Check, Errors } from "typebox/value";
import type { Model, ModelApi, ThinkingPreferences } from "../types.ts";

export const THINKING_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
const PositiveInteger = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const NativeEffort = Type.String({ pattern: "^[A-Za-z][A-Za-z0-9_-]*$" });
const ToggleFormat = Type.Union([Type.Literal("thinking-type"), Type.Literal("thinking-adaptive"), Type.Literal("enable-thinking")]);
const ThinkingRuleSchema = Type.Union([
	Type.Object({ mode: Type.Literal("unsupported") }, { additionalProperties: false }),
	Type.Object({ mode: Type.Literal("always") }, { additionalProperties: false }),
	Type.Object({
		mode: Type.Literal("adaptive"),
		levels: Type.Array(NativeEffort, { minItems: 1, maxItems: 5, uniqueItems: true }),
		canDisable: Type.Optional(Type.Boolean()),
	}, { additionalProperties: false }),
	Type.Object({
		mode: Type.Literal("effort"),
		/** Ordered from weakest to strongest. Local levels beyond this list repeat its last value. */
		levels: Type.Array(NativeEffort, { minItems: 1, maxItems: 5, uniqueItems: true }),
		off: Type.Optional(Type.Union([Type.Literal("none"), Type.Literal("off"), Type.Literal("disabled")])),
		toggle: Type.Optional(ToggleFormat),
		canDisable: Type.Optional(Type.Boolean()),
	}, { additionalProperties: false }),
	Type.Object({
		mode: Type.Literal("toggle"), format: ToggleFormat,
		canDisable: Type.Optional(Type.Boolean()),
	}, { additionalProperties: false }),
	Type.Object({
		mode: Type.Literal("budget"), format: Type.Union([Type.Literal("thinking-type"), Type.Literal("enable-thinking"), Type.Literal("anthropic")]),
		budgets: Type.Object({ low: PositiveInteger, medium: PositiveInteger, high: PositiveInteger, xhigh: PositiveInteger, max: PositiveInteger }, { additionalProperties: false }),
		minBudget: PositiveInteger,
		maxBudget: Type.Optional(PositiveInteger),
		answerReserveTokens: PositiveInteger,
		/** Some compatible APIs account for thinking separately from the answer limit. */
		budgetIncludesOutput: Type.Optional(Type.Boolean()),
		canDisable: Type.Optional(Type.Boolean()),
	}, { additionalProperties: false }),
]);

/**
 * Adapter-owned configuration; contains no keys, headers or arbitrary request JSON.
 * Shared schema, with protocol-specific fields checked by validateAdapterForApi.
 */
export const AdapterConfigSchema = Type.Object({
	preset: Type.Optional(Type.Union([
		Type.Literal("openai"), Type.Literal("anthropic"), Type.Literal("deepseek"),
		Type.Literal("kimi"), Type.Literal("qwen"), Type.Literal("glm"),
		Type.Literal("grok"), Type.Literal("gemini"), Type.Literal("minimax"),
	])),
	thinking: Type.Optional(ThinkingRuleSchema),
	maxTokensField: Type.Optional(Type.Union([Type.Literal("max_tokens"), Type.Literal("max_completion_tokens")])),
	systemRole: Type.Optional(Type.Union([Type.Literal("system"), Type.Literal("developer")])),
	includeUsage: Type.Optional(Type.Boolean()),
	reasoningField: Type.Optional(Type.Union([Type.Literal("reasoning_content"), Type.Literal("reasoning")])),
	reasoningReplay: Type.Optional(Type.Union([Type.Literal("omit"), Type.Literal("same-source"), Type.Literal("required")])),
	reasoningSummary: Type.Optional(Type.Union([Type.Literal("auto"), Type.Literal("concise"), Type.Literal("detailed")])),
	interleavedThinking: Type.Optional(Type.Boolean()),
	reasoningSplit: Type.Optional(Type.Boolean()),
	preserveThinking: Type.Optional(Type.Union([Type.Literal("glm"), Type.Literal("kimi")])),
	toolSignatures: Type.Optional(Type.Literal("google")),
	responsesReasoning: Type.Optional(Type.Union([Type.Literal("encrypted"), Type.Literal("summary"), Type.Literal("content"), Type.Literal("content-object"), Type.Literal("content-to-summary")])),
	toolResultFormat: Type.Optional(Type.Union([Type.Literal("content"), Type.Literal("text")])),
	thinkingSignature: Type.Optional(Type.Union([Type.Literal("required"), Type.Literal("optional")])),
	authHeader: Type.Optional(Type.Union([Type.Literal("api-key"), Type.Literal("bearer")])),
}, { additionalProperties: false });

export type AdapterConfig = Static<typeof AdapterConfigSchema>;
export type ThinkingRule = Static<typeof ThinkingRuleSchema>;
export interface ChatRules {
	thinking?: ThinkingRule;
	maxTokensField: "max_tokens" | "max_completion_tokens";
	systemRole: "system" | "developer";
	includeUsage: boolean;
	reasoningField: "reasoning_content" | "reasoning";
	reasoningReplay: "omit" | "same-source" | "required";
	reasoningSplit?: boolean;
	preserveThinking?: "glm" | "kimi";
	toolSignatures?: "google";
	requireToolSignature?: boolean;
}

// Initial reviewed binding, deliberately bounded rather than guessing future model names.
// Sources (checked 2026-10-16): https://developers.openai.com/api/docs/models/gpt-5.1
// and /api/reference/resources/chat/subresources/completions/methods/create .
// Kimi applyThinking / CC Switch piThinkingBindings informed the organization; no source copied.
const OPENAI_CHAT_MODELS: Array<{ model: RegExp; rules: Partial<ChatRules> }> = [{
	model: /^gpt-5\.1(?:-\d{4}-\d{2}-\d{2})?$/,
	rules: { thinking: { mode: "effort", levels: ["low", "medium", "high"], off: "none" }, systemRole: "developer" },
}, {
	model: /^gpt-5\.2(?:-\d{4}-\d{2}-\d{2})?$/,
	rules: { thinking: { mode: "effort", levels: ["low", "medium", "high", "xhigh"], off: "none" }, systemRole: "developer" },
}];

// Bounded, opt-in bindings checked against official vendor docs on 2026-10-20.
// Organization informed by Pi, Kimi Code and CC Switch. Unknown IDs require explicit rules.
const BUDGETS = { low: 1024, medium: 2048, high: 4096, xhigh: 8192, max: 16384 };
const CHAT_BINDINGS: Record<string, Array<{ model: RegExp; rules: Partial<ChatRules> }>> = {
	openai: OPENAI_CHAT_MODELS,
	deepseek: [{
		model: /^(?:deepseek-flash|deepseek-v4-pro|deepseek-v4-flash(?:-0731)?)$/,
		rules: { thinking: { mode: "effort", levels: ["low", "high", "max"], toggle: "thinking-type" }, reasoningReplay: "same-source" },
	}],
	kimi: [
		{ model: /^kimi-k2\.5$/, rules: { thinking: { mode: "toggle", format: "thinking-type" }, reasoningReplay: "same-source" } },
		{ model: /^kimi-k2\.6$/, rules: { thinking: { mode: "toggle", format: "thinking-type" }, reasoningReplay: "same-source", preserveThinking: "kimi" } },
		{ model: /^kimi-k2\.7-code(?:-highspeed)?$/, rules: { thinking: { mode: "always" }, reasoningReplay: "same-source" } },
		{ model: /^kimi-k3$/, rules: { thinking: { mode: "effort", levels: ["low", "high", "max"], canDisable: false }, reasoningReplay: "same-source" } },
	],
	glm: [
		{ model: /^glm-(?:4\.[56]|4\.5-air)$/i, rules: { thinking: { mode: "toggle", format: "thinking-type" }, reasoningReplay: "same-source" } },
		{ model: /^glm-(?:4\.7(?:-flash)?|5(?:\.[12])?)$/i, rules: { thinking: { mode: "toggle", format: "thinking-type" }, preserveThinking: "glm", reasoningReplay: "same-source" } },
		{ model: /^glm-5\.3(?:-flash)?$/i, rules: { thinking: { mode: "always" }, reasoningReplay: "same-source" } },
	],
	qwen: [
		{ model: /^qwen3-coder-(?:plus|next)(?:-\d{4}-\d{2}-\d{2})?$/, rules: { thinking: { mode: "unsupported" } } },
		{ model: /^qwen3\.[567]-(?:plus|flash)(?:-\d{4}-\d{2}-\d{2})?$/, rules: { thinking: { mode: "budget", format: "enable-thinking", budgets: BUDGETS, minBudget: 1, maxBudget: 81920, answerReserveTokens: 1024 }, reasoningReplay: "omit" } },
		{ model: /^qwen3-(?:235b-a22b|32b|30b-a3b|14b|8b)$/, rules: { thinking: { mode: "budget", format: "enable-thinking", budgets: BUDGETS, minBudget: 1, maxBudget: 32768, answerReserveTokens: 1024 } } },
	],
	minimax: [
		{ model: /^MiniMax-M2(?:\.[157])?(?:-highspeed)?$/, rules: { thinking: { mode: "always" }, reasoningSplit: true, reasoningReplay: "same-source" } },
		{ model: /^MiniMax-M3$/, rules: { thinking: { mode: "toggle", format: "thinking-adaptive" }, reasoningSplit: true, reasoningReplay: "same-source", maxTokensField: "max_completion_tokens" } },
		{ model: /^MiniMax-M3\.1-Flash$/, rules: { thinking: { mode: "effort", levels: [...THINKING_LEVELS], canDisable: false }, reasoningSplit: true, reasoningReplay: "same-source", maxTokensField: "max_completion_tokens" } },
	],
	grok: [
		{ model: /^grok-4\.3$/, rules: { thinking: { mode: "effort", levels: ["low", "medium", "high", "xhigh"], off: "none" } } },
		{ model: /^grok-4\.5$/, rules: { thinking: { mode: "effort", levels: ["low", "medium", "high"], canDisable: false } } },
		{ model: /^grok-4\.[67]$/, rules: { thinking: { mode: "effort", levels: ["low", "medium", "high", "xhigh"], canDisable: false } } },
	],
	gemini: [
		{ model: /^gemini-2\.5-flash(?:-lite)?$/, rules: { thinking: { mode: "effort", levels: ["low", "medium", "high"], off: "none" }, toolSignatures: "google" } },
		{ model: /^gemini-2\.5-pro$/, rules: { thinking: { mode: "effort", levels: ["low", "medium", "high"], canDisable: false }, toolSignatures: "google" } },
		{ model: /^gemini-(?:3-flash-preview|3\.1-flash-lite)$/, rules: { thinking: { mode: "effort", levels: ["minimal", "low", "medium", "high"], canDisable: false }, toolSignatures: "google", requireToolSignature: true } },
		{ model: /^gemini-(?:3-pro-preview|3\.1-pro-preview)$/, rules: { thinking: { mode: "effort", levels: ["low", "high"], canDisable: false }, toolSignatures: "google", requireToolSignature: true } },
	],
};

export function validateAdapterConfig(value: unknown): asserts value is AdapterConfig {
	if (!Check(AdapterConfigSchema, value)) {
		const error = Errors(AdapterConfigSchema, value)[0];
		throw new ByokConfigError(`adapter 配置无效：${error?.instancePath || "/"}（${error?.keyword ?? "schema"}）。`);
	}
	const rule = value.thinking;
	if (rule?.mode === "effort" || rule?.mode === "adaptive") {
		if (rule.levels.some(level => ["none", "off", "disabled"].includes(level.toLowerCase()))) {
			throw new ByokConfigError("thinking.levels 只能包含开启档位；关闭值应放入 off。");
		}
	}
	if (rule?.mode === "effort") {
		if (rule.off !== undefined && (rule.toggle !== undefined || rule.levels.includes(rule.off))) {
			throw new ByokConfigError("effort 的 off 不能与开启档位或 toggle 冲突。");
		}
		if (rule.canDisable === false && rule.off !== undefined) throw new ByokConfigError("canDisable: false 不能同时指定 off 编码。");
	}
	if (rule?.mode === "budget") {
		const budgets = THINKING_LEVELS.map(level => rule.budgets[level]);
		if (budgets.some((budget, index) => budget < rule.minBudget || (rule.maxBudget !== undefined && budget > rule.maxBudget) || (index > 0 && budget <= budgets[index - 1]!))) {
			throw new ByokConfigError("thinking.budgets 必须有五个严格递增且位于 minBudget/maxBudget 范围内的值。");
		}
	}
}

/** Explicit model config > opted-in preset/model binding > conservative protocol defaults. */
export function resolveChatRules(model: Model): ChatRules {
	if (model.api !== "openai-completions") throw new ByokConfigError(`OpenAI Chat adapter does not implement '${model.api}'.`);
	if (model.adapter !== undefined) validateAdapterForApi(model.adapter, model.api);
	const config = model.adapter;
	const preset = config?.preset ? CHAT_BINDINGS[config.preset]?.find(binding => binding.model.test(model.id))?.rules : undefined;
	const rules: ChatRules = {
		maxTokensField: config?.preset === "openai" ? "max_completion_tokens" : "max_tokens",
		systemRole: "system", includeUsage: true, reasoningField: "reasoning_content", reasoningReplay: "omit",
		...preset, ...config,
	};
	if (model.capabilities?.thinking === false) {
		if (config?.thinking && config.thinking.mode !== "unsupported") {
			throw new ByokConfigError(`模型 ${model.id} 的 thinking 能力与 adapter 规则冲突。`);
		}
		rules.thinking = { mode: "unsupported" };
	}
	return structuredClone(rules);
}

function encodeToggle(format: "thinking-type" | "thinking-adaptive" | "enable-thinking", enabled: boolean): Record<string, unknown> {
	if (format === "enable-thinking") return { enable_thinking: enabled };
	return { thinking: { type: enabled ? (format === "thinking-adaptive" ? "adaptive" : "enabled") : "disabled" } };
}

/** Resolve the user's intent and encode only the mutually compatible fields for this request. */
export function encodeChatThinking(rules: ChatRules, preferences: ThinkingPreferences | undefined, maxTokens: number | undefined): Record<string, unknown> {
	if (preferences?.enabled === undefined) return {};
	const index = THINKING_LEVELS.indexOf(preferences.effort);
	if (index < 0 || typeof preferences.enabled !== "boolean") throw new ByokConfigError("无效的思考偏好。");
	const rule = rules.thinking;
	if (!rule) throw new ByokConfigError("当前接口没有思考控制规则；请在 adapter.thinking 中明确配置，或省略 enabled 使用服务端默认。");
	if (rule.mode === "always") {
		if (!preferences.enabled) throw new ByokConfigError("当前模型始终思考，无法真实关闭。");
		return {};
	}
	if (rule.mode === "unsupported") {
		if (preferences.enabled) throw new ByokConfigError("当前模型不支持开启思考。");
		return {};
	}
	if (rule.mode === "adaptive") throw new ByokConfigError("Chat 不支持 Anthropic 思考编码。");
	if (rule.mode === "effort") {
		if (!preferences.enabled) {
			if (rule.canDisable === false) throw new ByokConfigError("当前模型无法关闭思考。");
			if (rule.toggle) return encodeToggle(rule.toggle, false);
			if (rule.off !== undefined) return { reasoning_effort: rule.off };
			throw new ByokConfigError("当前模型没有真实关闭思考的编码。");
		}
		return { ...(rule.toggle ? encodeToggle(rule.toggle, true) : {}), reasoning_effort: rule.levels[Math.min(index, rule.levels.length - 1)] };
	}
	if (rule.format === "anthropic") throw new ByokConfigError("Chat 不支持 Anthropic 思考编码。");
	if (!preferences.enabled) {
		if (rule.canDisable === false) throw new ByokConfigError("当前模型无法关闭思考。");
		return encodeToggle(rule.format, false);
	}
	if (rule.mode === "toggle") return encodeToggle(rule.format, true);
	if (maxTokens === undefined) throw new ByokConfigError("预算思考需要明确设置 maxOutputTokens 或请求 maxTokens。");
	const budget = Math.min(rule.budgets[preferences.effort], maxTokens - rule.answerReserveTokens);
	if (budget < rule.minBudget) throw new ByokConfigError("输出上限无法同时容纳最低思考预算与回答预留空间。");
	return rule.format === "thinking-type"
		? { thinking: { type: "enabled", budget_tokens: budget } }
		: { enable_thinking: true, thinking_budget: budget };
}

/** Reject misplaced fields instead of silently interpreting Chat options as another protocol. */
export function validateAdapterForApi(config: AdapterConfig, api: ModelApi): void {
	validateAdapterConfig(config);
	const chatOnly = ["maxTokensField", "systemRole", "includeUsage", "reasoningField", "reasoningSplit", "preserveThinking", "toolSignatures"] as const;
	if (api !== "openai-completions" && chatOnly.some(key => config[key] !== undefined)) {
		throw new ByokConfigError(`${api} 不接受 Chat 专用的输出字段、systemRole、includeUsage 或 reasoningField。`);
	}
	if (api !== "openai-responses" && config.reasoningSummary !== undefined) throw new ByokConfigError("reasoningSummary 仅用于 Responses。");
	if (api !== "anthropic-messages" && (config.interleavedThinking !== undefined || config.preset === "anthropic")) throw new ByokConfigError("Anthropic 预设及 interleavedThinking 仅用于 Messages。");
	if (api === "anthropic-messages" && config.preset === "openai") throw new ByokConfigError("Messages 不能使用 OpenAI 预设。");
	if (api !== "openai-responses" && config.responsesReasoning !== undefined) throw new ByokConfigError("responsesReasoning 仅用于 Responses。");
	if (api !== "anthropic-messages" && (config.thinkingSignature !== undefined || config.authHeader !== undefined)) throw new ByokConfigError("thinkingSignature 和 authHeader 仅用于 Messages。");
	if (api === "openai-completions" && config.toolResultFormat !== undefined) throw new ByokConfigError("toolResultFormat 仅用于 Responses／Messages。");
	if (api !== "openai-completions" && config.preset && !NATIVE_PRESETS[api]?.includes(config.preset)) {
		throw new ByokConfigError(`${config.preset} 尚未绑定 ${api}；请使用已确认的协议入口或显式配置规则。`);
	}
	const rule = config.thinking;
	if (!rule || rule.mode === "unsupported" || rule.mode === "always") return;
	if (api !== "anthropic-messages" && rule.mode === "budget" && rule.budgetIncludesOutput !== undefined) throw new ByokConfigError("budgetIncludesOutput 仅用于 Messages 预算。");
	if (api === "openai-completions" && (rule.mode === "adaptive" || (rule.mode === "budget" && rule.format === "anthropic"))) throw new ByokConfigError("Chat 不接受 Anthropic 思考规则。");
	if (api === "openai-responses" && !((rule.mode === "effort" && rule.toggle === undefined && (rule.off === undefined || rule.off === "none")) || (rule.mode === "toggle" && rule.format === "enable-thinking"))) throw new ByokConfigError("Responses 思考使用 effort（关闭为 none）或明确配置的 enable-thinking 开关。");
	if (api === "anthropic-messages") {
		if (rule.mode === "effort" && (rule.off !== undefined || (rule.toggle !== undefined && rule.toggle !== "thinking-type" && rule.toggle !== "thinking-adaptive"))) throw new ByokConfigError("Messages effort 使用 output_config.effort 和可选 thinking 开关。");
		if (rule.mode === "toggle" && rule.format === "enable-thinking") throw new ByokConfigError("Messages 开关使用 thinking.type。");
		if (rule.mode === "budget" && rule.format !== "anthropic") throw new ByokConfigError("Messages 预算需要 format: anthropic。");
		if (rule.mode === "budget" && rule.budgetIncludesOutput !== false && rule.minBudget < 1024) throw new ByokConfigError("Anthropic 最低思考预算不能小于 1024。");
	}
}

export interface NativeRules {
	thinking?: ThinkingRule;
	reasoningReplay: "omit" | "same-source" | "required";
	reasoningSummary?: "auto" | "concise" | "detailed";
	interleavedThinking: boolean;
	responsesReasoning: "encrypted" | "summary" | "content" | "content-object" | "content-to-summary";
	toolResultFormat: "content" | "text";
	thinkingSignature: "required" | "optional";
	authHeader: "api-key" | "bearer";
}

const NATIVE_PRESETS: Partial<Record<ModelApi, readonly string[]>> = {
	"openai-responses": ["openai", "deepseek", "kimi", "qwen", "glm", "grok", "minimax"],
	"anthropic-messages": ["anthropic", "deepseek", "kimi", "qwen", "glm", "minimax"],
};

// Protocol-specific bindings checked against vendor documentation on 2026-10-21.
// A model may have different controls on Chat, Responses and Messages.
// Sources: api-docs.deepseek.com/guides/{responses_api,anthropic_api,thinking_mode}/;
// platform.kimi.com/docs/api/{responses,messages}; platform.kimi.ai/docs/api/{responses,messages};
// docs.bigmodel.cn/cn/guide/develop/responses/introduction; docs.bigmodel.cn/cn/coding-plan/tool/claude;
// docs.z.ai/devpack/tool/claude; help.aliyun.com/zh/model-studio/{qwen-api-via-openai-responses,anthropic-api-messages};
// platform.minimax.io/docs/api-reference/{responses-create,text-anthropic-api,text/api/openapi-responses.json};
// docs.x.ai/developers/model-capabilities/text/reasoning.
const NATIVE_BINDINGS: Partial<Record<ModelApi, Record<string, Array<{ model: RegExp; rules: Partial<NativeRules> }>>>> = {
	"openai-responses": {
		deepseek: [{ model: /^(?:deepseek-flash|deepseek-v4-pro|deepseek-v4-flash(?:-0731)?)$/, rules: { thinking: { mode: "effort", levels: ["low", "high", "max"], off: "none" } } }],
		kimi: [{ model: /^kimi-k3$/, rules: { thinking: { mode: "effort", levels: ["low", "high", "max"], canDisable: false } } }],
		glm: [{ model: /^glm-5\.3$/i, rules: { thinking: { mode: "effort", levels: ["high", "max"], off: "none" } } }],
		qwen: [
			{ model: /^qwen3\.8-(?:max(?:-0902)?|flash|2\.4t-a95b|27b)$/, rules: { thinking: { mode: "effort", levels: ["low", "medium", "xhigh"], off: "none" } } },
			{ model: /^qwen3\.[567]-(?:plus|flash)(?:-\d{4}-\d{2}-\d{2})?$/, rules: { thinking: { mode: "toggle", format: "enable-thinking" } } },
		],
		grok: CHAT_BINDINGS.grok!.map(({ model, rules }) => ({ model, rules: { thinking: rules.thinking } })),
		minimax: [
			{ model: /^MiniMax-M3$/, rules: { thinking: { mode: "effort", levels: ["high"], off: "none" } } },
			{ model: /^MiniMax-M3\.1-Flash$/, rules: { thinking: { mode: "effort", levels: [...THINKING_LEVELS], canDisable: false } } },
		],
	},
	"anthropic-messages": {
		deepseek: [{ model: /^(?:deepseek-flash|deepseek-v4-pro|deepseek-v4-flash(?:-0731)?)$/, rules: { thinking: { mode: "effort", levels: ["low", "high", "max"], toggle: "thinking-type" } } }],
		kimi: [{ model: /^kimi-k3$/, rules: { thinking: { mode: "effort", levels: ["low", "high", "max"], canDisable: false } } }],
		glm: [
			{ model: /^glm-(?:4\.[567]|4\.7-flash|4\.5-air|5(?:\.[12])?)$/i, rules: { thinking: { mode: "toggle", format: "thinking-type" } } },
			{ model: /^glm-5\.3(?:-flash)?$/i, rules: { thinking: { mode: "always" } } },
		],
		qwen: [
			{ model: /^qwen3\.8-(?:max(?:-0902)?|flash)$/, rules: { thinking: { mode: "effort", levels: ["low", "medium", "xhigh"], toggle: "thinking-type" } } },
			{ model: /^qwen3\.[567]-(?:plus|flash)(?:-\d{4}-\d{2}-\d{2})?$/, rules: { thinking: { mode: "budget", format: "anthropic", budgets: BUDGETS, minBudget: 1, maxBudget: 81920, answerReserveTokens: 1024, budgetIncludesOutput: false } } },
			{ model: /^qwen3-coder-(?:plus|next)(?:-\d{4}-\d{2}-\d{2})?$/, rules: { thinking: { mode: "unsupported" } } },
		],
		minimax: [
			{ model: /^MiniMax-M3$/, rules: { thinking: { mode: "toggle", format: "thinking-adaptive" } } },
			{ model: /^MiniMax-M3\.1-Flash$/, rules: { thinking: { mode: "adaptive", levels: [...THINKING_LEVELS], canDisable: false } } },
		],
	},
};

const NATIVE_DEFAULTS: Partial<Record<ModelApi, Record<string, Partial<NativeRules>>>> = {
	"openai-responses": {
		deepseek: { responsesReasoning: "content" }, kimi: { responsesReasoning: "summary" },
		qwen: { responsesReasoning: "summary" }, glm: { responsesReasoning: "content-object", toolResultFormat: "text" },
		minimax: { responsesReasoning: "content-to-summary" },
	},
	"anthropic-messages": {
		deepseek: { thinkingSignature: "optional" }, kimi: { thinkingSignature: "optional", authHeader: "bearer" },
		qwen: { thinkingSignature: "optional", toolResultFormat: "text" },
		glm: { thinkingSignature: "optional", authHeader: "bearer" }, minimax: { authHeader: "bearer" },
	},
};

// Project policy, not a vendor-provided five-level scale. Kept below the 32k long-request
// guidance and checked against max_tokens on every request, including summaries.
const ANTHROPIC_BUDGET: ThinkingRule = {
	mode: "budget", format: "anthropic", minBudget: 1024, answerReserveTokens: 1024,
	budgets: { low: 1024, medium: 2048, high: 4096, xhigh: 8192, max: 16384 },
};

/** Opt-in, bounded model bindings. Claude budget/adaptive rules checked 2026-10-17:
 * https://platform.claude.com/docs/en/build-with-claude/{extended-thinking,effort}.
 */
export function resolveNativeRules(model: Model): NativeRules {
	const config = model.adapter ?? {};
	validateAdapterForApi(config, model.api);
	let thinking: ThinkingRule | undefined;
	const preset = config.preset ? NATIVE_DEFAULTS[model.api]?.[config.preset] : undefined;
	const binding = config.preset ? NATIVE_BINDINGS[model.api]?.[config.preset]?.find(entry => entry.model.test(model.id))?.rules : undefined;
	if (model.api === "openai-responses" && config.preset === "openai") {
		thinking = OPENAI_CHAT_MODELS.find(binding => binding.model.test(model.id))?.rules.thinking;
	}
	if (model.api === "anthropic-messages" && config.preset === "anthropic") {
		if (/^claude-(?:opus|sonnet|haiku)-4-5(?:-\d{8})?$/.test(model.id)) thinking = ANTHROPIC_BUDGET;
		if (/^claude-opus-4-6(?:-\d{8})?$/.test(model.id)) thinking = { mode: "adaptive", levels: ["low", "medium", "high", "max"] };
		if (/^claude-sonnet-4-6(?:-\d{8})?$/.test(model.id)) thinking = { mode: "adaptive", levels: ["low", "medium", "high", "max"] };
	}
	thinking = config.thinking ?? binding?.thinking ?? thinking;
	if (model.capabilities?.thinking === false) {
		if (config.thinking && config.thinking.mode !== "unsupported") throw new ByokConfigError(`模型 ${model.id} 的 thinking 能力与 adapter 规则冲突。`);
		thinking = { mode: "unsupported" };
	}
	return structuredClone({ reasoningReplay: "same-source", interleavedThinking: false,
		responsesReasoning: "encrypted", toolResultFormat: "content", thinkingSignature: "required", authHeader: "api-key",
		...preset, ...binding, ...config, thinking } as NativeRules);
}

export function encodeNativeThinking(api: ModelApi, rules: NativeRules, preferences: ThinkingPreferences | undefined, maxTokens: number | undefined): Record<string, unknown> {
	if (preferences?.enabled === undefined) return {};
	const index = THINKING_LEVELS.indexOf(preferences.effort);
	if (index < 0 || typeof preferences.enabled !== "boolean") throw new ByokConfigError("无效的思考偏好。");
	const rule = rules.thinking;
	if (!rule) throw new ByokConfigError("当前接口没有思考控制规则；请配置 adapter.thinking，或省略 enabled 使用服务端默认。");
	if (rule.mode === "always") {
		if (!preferences.enabled) throw new ByokConfigError("当前模型始终思考，无法真实关闭。");
		return {};
	}
	if (rule.mode === "unsupported") {
		if (preferences.enabled) throw new ByokConfigError("当前模型不支持开启思考。");
		return {};
	}
	if (!preferences.enabled) {
		if (rule.canDisable === false) throw new ByokConfigError("当前模型无法关闭思考。");
		if (api === "anthropic-messages") return { thinking: { type: "disabled" } };
		if (rule.mode === "toggle") return encodeToggle(rule.format, false);
		if (rule.mode === "effort" && rule.off) return { reasoning: { effort: rule.off } };
		throw new ByokConfigError("当前模型没有真实关闭思考的编码。");
	}
	if (api === "openai-responses" && rule.mode === "effort") return { reasoning: { effort: rule.levels[Math.min(index, rule.levels.length - 1)] } };
	if (api === "openai-responses" && rule.mode === "toggle") return encodeToggle(rule.format, true);
	if (api === "anthropic-messages" && rule.mode === "adaptive") return { thinking: { type: "adaptive" }, output_config: { effort: rule.levels[Math.min(index, rule.levels.length - 1)] } };
	if (api === "anthropic-messages" && rule.mode === "effort") return {
		...(rule.toggle ? encodeToggle(rule.toggle, true) : {}), output_config: { effort: rule.levels[Math.min(index, rule.levels.length - 1)] },
	};
	if (api === "anthropic-messages" && rule.mode === "toggle") return encodeToggle(rule.format, true);
	if (api === "anthropic-messages" && rule.mode === "budget") {
		if (maxTokens === undefined) throw new ByokConfigError("预算思考需要明确设置 maxOutputTokens 或请求 maxTokens。");
		const budget = rule.budgetIncludesOutput === false ? rule.budgets[preferences.effort] : Math.min(rule.budgets[preferences.effort], maxTokens - rule.answerReserveTokens);
		if (budget < rule.minBudget) throw new ByokConfigError("输出上限无法同时容纳最低思考预算与回答预留空间。");
		return { thinking: { type: "enabled", budget_tokens: budget } };
	}
	throw new ByokConfigError("当前协议与思考规则不匹配。");
}
