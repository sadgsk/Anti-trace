import { Type, type Static } from "typebox";
import { Check, Errors } from "typebox/value";
import type { Model, ThinkingPreferences } from "../types.ts";

export const THINKING_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
const PositiveInteger = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const NativeEffort = Type.String({ pattern: "^[A-Za-z][A-Za-z0-9_-]*$" });
const ToggleFormat = Type.Union([Type.Literal("thinking-type"), Type.Literal("enable-thinking")]);
const ThinkingRuleSchema = Type.Union([
	Type.Object({ mode: Type.Literal("unsupported") }, { additionalProperties: false }),
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
		mode: Type.Literal("budget"), format: ToggleFormat,
		budgets: Type.Object({ low: PositiveInteger, medium: PositiveInteger, high: PositiveInteger, xhigh: PositiveInteger, max: PositiveInteger }, { additionalProperties: false }),
		minBudget: PositiveInteger,
		maxBudget: Type.Optional(PositiveInteger),
		answerReserveTokens: PositiveInteger,
		canDisable: Type.Optional(Type.Boolean()),
	}, { additionalProperties: false }),
]);

/**
 * Adapter-owned configuration; contains no keys, headers or arbitrary request JSON.
 * 当前字段是完整的 Chat 配置语义。05＋06／07＋08 新增协议配置时按协议扩展校验，
 * 保留这些 Chat 字段的含义，不将其临时解释成 Responses／Anthropic 参数。
 */
export const AdapterConfigSchema = Type.Object({
	preset: Type.Optional(Type.Literal("openai")),
	thinking: Type.Optional(ThinkingRuleSchema),
	maxTokensField: Type.Optional(Type.Union([Type.Literal("max_tokens"), Type.Literal("max_completion_tokens")])),
	systemRole: Type.Optional(Type.Union([Type.Literal("system"), Type.Literal("developer")])),
	includeUsage: Type.Optional(Type.Boolean()),
	reasoningField: Type.Optional(Type.Union([Type.Literal("reasoning_content"), Type.Literal("reasoning")])),
	reasoningReplay: Type.Optional(Type.Union([Type.Literal("omit"), Type.Literal("same-source"), Type.Literal("required")])),
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
}

// Initial reviewed binding, deliberately bounded rather than guessing future model names.
// Sources (checked 2026-10-16): https://developers.openai.com/api/docs/models/gpt-5.1
// and /api/reference/resources/chat/subresources/completions/methods/create .
// Kimi applyThinking / CC Switch piThinkingBindings informed the organization; no source copied.
const OPENAI_CHAT_MODELS: Array<{ model: RegExp; rules: Partial<ChatRules> }> = [{
	model: /^gpt-5\.1(?:-\d{4}-\d{2}-\d{2})?$/,
	rules: { thinking: { mode: "effort", levels: ["low", "medium", "high"], off: "none" }, systemRole: "developer" },
}];

export function validateAdapterConfig(value: unknown): asserts value is AdapterConfig {
	if (!Check(AdapterConfigSchema, value)) {
		const error = Errors(AdapterConfigSchema, value)[0];
		throw new Error(`adapter 配置无效：${error?.instancePath || "/"}（${error?.keyword ?? "schema"}）。`);
	}
	const rule = value.thinking;
	if (rule?.mode === "effort") {
		if (rule.levels.some(level => ["none", "off", "disabled"].includes(level.toLowerCase()))) {
			throw new Error("thinking.levels 只能包含开启档位；关闭值应放入 off。");
		}
		if (rule.off !== undefined && (rule.toggle !== undefined || rule.levels.includes(rule.off))) {
			throw new Error("effort 的 off 不能与开启档位或 toggle 冲突。");
		}
		if (rule.canDisable === false && rule.off !== undefined) throw new Error("canDisable: false 不能同时指定 off 编码。");
	}
	if (rule?.mode === "budget") {
		const budgets = THINKING_LEVELS.map(level => rule.budgets[level]);
		if (budgets.some((budget, index) => budget < rule.minBudget || (rule.maxBudget !== undefined && budget > rule.maxBudget) || (index > 0 && budget <= budgets[index - 1]!))) {
			throw new Error("thinking.budgets 必须有五个严格递增且位于 minBudget/maxBudget 范围内的值。");
		}
	}
}

/** Explicit model config > opted-in preset/model binding > conservative protocol defaults. */
export function resolveChatRules(model: Model): ChatRules {
	if (model.api !== "openai-completions") throw new Error(`OpenAI Chat adapter does not implement '${model.api}'.`);
	if (model.adapter !== undefined) validateAdapterConfig(model.adapter);
	const config = model.adapter;
	const preset = config?.preset === "openai"
		? OPENAI_CHAT_MODELS.find(binding => binding.model.test(model.id))?.rules
		: undefined;
	const rules: ChatRules = {
		maxTokensField: config?.preset === "openai" ? "max_completion_tokens" : "max_tokens",
		systemRole: "system", includeUsage: true, reasoningField: "reasoning_content", reasoningReplay: "omit",
		...preset, ...config,
	};
	if (model.capabilities?.thinking === false) {
		if (config?.thinking && config.thinking.mode !== "unsupported") {
			throw new Error(`模型 ${model.id} 的 thinking 能力与 adapter 规则冲突。`);
		}
		rules.thinking = { mode: "unsupported" };
	}
	return structuredClone(rules);
}

function encodeToggle(format: "thinking-type" | "enable-thinking", enabled: boolean): Record<string, unknown> {
	return format === "thinking-type"
		? { thinking: { type: enabled ? "enabled" : "disabled" } }
		: { enable_thinking: enabled };
}

/** Resolve the user's intent and encode only the mutually compatible fields for this request. */
export function encodeChatThinking(rules: ChatRules, preferences: ThinkingPreferences | undefined, maxTokens: number | undefined): Record<string, unknown> {
	if (preferences?.enabled === undefined) return {};
	const index = THINKING_LEVELS.indexOf(preferences.effort);
	if (index < 0 || typeof preferences.enabled !== "boolean") throw new Error("无效的思考偏好。");
	const rule = rules.thinking;
	if (!rule) throw new Error("当前接口没有思考控制规则；请在 adapter.thinking 中明确配置，或省略 enabled 使用服务端默认。");
	if (rule.mode === "unsupported") {
		if (preferences.enabled) throw new Error("当前模型不支持开启思考。");
		return {};
	}
	if (rule.mode === "effort") {
		if (!preferences.enabled) {
			if (rule.canDisable === false) throw new Error("当前模型无法关闭思考。");
			if (rule.toggle) return encodeToggle(rule.toggle, false);
			if (rule.off !== undefined) return { reasoning_effort: rule.off };
			throw new Error("当前模型没有真实关闭思考的编码。");
		}
		return { ...(rule.toggle ? encodeToggle(rule.toggle, true) : {}), reasoning_effort: rule.levels[Math.min(index, rule.levels.length - 1)] };
	}
	if (!preferences.enabled) {
		if (rule.canDisable === false) throw new Error("当前模型无法关闭思考。");
		return encodeToggle(rule.format, false);
	}
	if (rule.mode === "toggle") return encodeToggle(rule.format, true);
	if (maxTokens === undefined) throw new Error("预算思考需要明确设置 maxOutputTokens 或请求 maxTokens。");
	const budget = Math.min(rule.budgets[preferences.effort], maxTokens - rule.answerReserveTokens);
	if (budget < rule.minBudget) throw new Error("输出上限无法同时容纳最低思考预算与回答预留空间。");
	return rule.format === "thinking-type"
		? { thinking: { type: "enabled", budget_tokens: budget } }
		: { enable_thinking: true, thinking_budget: budget };
}
