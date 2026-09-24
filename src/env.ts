import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export interface OpenAIConfig {
	apiKey: string;
	baseUrl: string;
	modelId: string;
	contextWindow: number;
}

export const DEFAULT_CONTEXT_WINDOW = 256000;

/** Read a positive-integer window; anything unusable falls back to the default. */
function parseContextWindow(raw: string | undefined): number {
	if (!raw) {
		return DEFAULT_CONTEXT_WINDOW;
	}
	const value = Number.parseInt(raw, 10);
	if (!Number.isInteger(value) || value <= 0) {
		return DEFAULT_CONTEXT_WINDOW;
	}
	return value;
}

function parseDotEnv(text: string): Record<string, string> {
	const values: Record<string, string> = {};
	for (const rawLine of text.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (line.length === 0 || line.startsWith("#")) continue;
		const eq = line.indexOf("=");
		if (eq <= 0) continue;
		const key = line.slice(0, eq).trim();
		let value = line.slice(eq + 1).trim();
		if (
			(value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))
		) {
			value = value.slice(1, -1);
		}
		values[key] = value;
	}
	return values;
}

/** Load `.env` from cwd. Existing process.env keys win. */
export function loadDotEnv(filePath = resolve(process.cwd(), ".env")): void {
	let text: string;
	try {
		text = readFileSync(filePath, "utf8");
	} catch {
		return;
	}
	const values = parseDotEnv(text);
	for (const [key, value] of Object.entries(values)) {
		if (process.env[key] === undefined) {
			process.env[key] = value;
		}
	}
}

export function getOpenAIConfig(): OpenAIConfig {
	loadDotEnv();
	const apiKey = process.env.OPENAI_API_KEY?.trim();
	if (!apiKey) {
		throw new Error("缺少 OPENAI_API_KEY。请在项目根目录的 .env 里填写，或在终端里设置同名环境变量。");
	}
	return {
		apiKey,
		baseUrl: process.env.OPENAI_BASE_URL?.trim() || "https://api.openai.com/v1",
		modelId: process.env.OPENAI_MODEL?.trim() || "gpt-4o-mini",
		contextWindow: parseContextWindow(process.env.OPENAI_CONTEXT_WINDOW?.trim()),
	};
}
