import type { ModelApi } from "../types.ts";
import type { AdapterConfig } from "../llm/rules.ts";

/** Explicit connection choices. Regions/plans have independent keys; never rewrite a host.
 * Model coverage is bounded by rules.ts; examples are in byok.providers.example.json.
 * Regional separation follows Pi's provider catalog; URLs checked against vendor docs on 2026-10-21.
 */
export const CONNECTION_PRESETS = {
	openai: { api: "openai-responses", baseUrl: "https://api.openai.com/v1", adapter: { preset: "openai", reasoningSummary: "auto" } },
	"openai-chat": { api: "openai-completions", baseUrl: "https://api.openai.com/v1", adapter: { preset: "openai" } },
	anthropic: { api: "anthropic-messages", baseUrl: "https://api.anthropic.com/v1", adapter: { preset: "anthropic" } },
	deepseek: { api: "openai-completions", baseUrl: "https://api.deepseek.com/v1", adapter: { preset: "deepseek" } },
	"kimi-cn": { api: "openai-completions", baseUrl: "https://api.moonshot.cn/v1", adapter: { preset: "kimi" } },
	"kimi-global": { api: "openai-completions", baseUrl: "https://api.moonshot.ai/v1", adapter: { preset: "kimi" } },
	"glm-cn": { api: "openai-completions", baseUrl: "https://open.bigmodel.cn/api/paas/v4", adapter: { preset: "glm" } },
	"glm-global": { api: "openai-completions", baseUrl: "https://api.z.ai/api/paas/v4", adapter: { preset: "glm" } },
	"glm-coding-cn": { api: "openai-completions", baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4", adapter: { preset: "glm" } },
	"glm-coding-global": { api: "openai-completions", baseUrl: "https://api.z.ai/api/coding/paas/v4", adapter: { preset: "glm" } },
	"minimax-cn": { api: "openai-completions", baseUrl: "https://api.minimax.cn/v1", adapter: { preset: "minimax" } },
	"minimax-global": { api: "openai-completions", baseUrl: "https://api.minimax.io/v1", adapter: { preset: "minimax" } },
	"qwen-cn": { api: "openai-completions", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", adapter: { preset: "qwen" } },
	"qwen-global": { api: "openai-completions", baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1", adapter: { preset: "qwen" } },
	"qwen-us": { api: "openai-completions", baseUrl: "https://dashscope-us.aliyuncs.com/compatible-mode/v1", adapter: { preset: "qwen" } },
	grok: { api: "openai-completions", baseUrl: "https://api.x.ai/v1", adapter: { preset: "grok" } },
	gemini: { api: "openai-completions", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", adapter: { preset: "gemini" } },
	// Each protocol has its own documented root; do not derive these by changing an existing path.
	"deepseek-responses": { api: "openai-responses", baseUrl: "https://api.deepseek.com", adapter: { preset: "deepseek" } },
	"deepseek-anthropic": { api: "anthropic-messages", baseUrl: "https://api.deepseek.com/anthropic/v1", adapter: { preset: "deepseek" } },
	"kimi-cn-responses": { api: "openai-responses", baseUrl: "https://api.moonshot.cn/v1", adapter: { preset: "kimi" } },
	"kimi-cn-anthropic": { api: "anthropic-messages", baseUrl: "https://api.moonshot.cn/anthropic/v1", adapter: { preset: "kimi" } },
	"kimi-global-responses": { api: "openai-responses", baseUrl: "https://api.moonshot.ai/v1", adapter: { preset: "kimi" } },
	"kimi-global-anthropic": { api: "anthropic-messages", baseUrl: "https://api.moonshot.ai/anthropic/v1", adapter: { preset: "kimi" } },
	"glm-cn-responses": { api: "openai-responses", baseUrl: "https://open.bigmodel.cn/api/v1", adapter: { preset: "glm" } },
	"glm-cn-anthropic": { api: "anthropic-messages", baseUrl: "https://open.bigmodel.cn/api/anthropic/v1", adapter: { preset: "glm" } },
	"glm-global-anthropic": { api: "anthropic-messages", baseUrl: "https://api.z.ai/api/anthropic/v1", adapter: { preset: "glm" } },
	"minimax-cn-responses": { api: "openai-responses", baseUrl: "https://api.minimax.cn/v1", adapter: { preset: "minimax" } },
	"minimax-global-responses": { api: "openai-responses", baseUrl: "https://api.minimax.io/v1", adapter: { preset: "minimax" } },
	"minimax-cn-anthropic": { api: "anthropic-messages", baseUrl: "https://api.minimax.cn/anthropic/v1", adapter: { preset: "minimax" } },
	"minimax-global-anthropic": { api: "anthropic-messages", baseUrl: "https://api.minimax.io/anthropic/v1", adapter: { preset: "minimax" } },
	"qwen-cn-responses": { api: "openai-responses", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", adapter: { preset: "qwen" } },
	"qwen-global-responses": { api: "openai-responses", baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1", adapter: { preset: "qwen" } },
	"qwen-us-responses": { api: "openai-responses", baseUrl: "https://dashscope-us.aliyuncs.com/compatible-mode/v1", adapter: { preset: "qwen" } },
	"qwen-cn-anthropic": { api: "anthropic-messages", baseUrl: "https://dashscope.aliyuncs.com/apps/anthropic/v1", adapter: { preset: "qwen" } },
	"qwen-global-anthropic": { api: "anthropic-messages", baseUrl: "https://dashscope-intl.aliyuncs.com/apps/anthropic/v1", adapter: { preset: "qwen" } },
	"grok-responses": { api: "openai-responses", baseUrl: "https://api.x.ai/v1", adapter: { preset: "grok" } },
} as const satisfies Record<string, { api: ModelApi; baseUrl: string; adapter: AdapterConfig }>;
