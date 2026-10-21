import { resolve } from "node:path";
import { loadByokConfig, type LoadedByokConfig, type LoadByokConfigOptions } from "../config/byok.ts";
import { ByokConfigError } from "../config/errors.ts";
import type { ModelReference, SessionSettings } from "../types.ts";
import type { HarnessModelSettings } from "../harness/harness.ts";

export const BYOK_RECOVERY_HELP = "修改配置文件后输入 /reload 重试；/config <路径> 更换文件，/model <模型键> 重新选择，/exit 退出。";

export type ByokReloadResult = { ok: true; message: string; warnings: string[] } | { ok: false; reason: string; message: string };

/** Loads and applies configuration; does not own the Harness or its lifecycle. */
export class ByokRuntime {
	private selection: LoadByokConfigOptions;
	private config?: LoadedByokConfig;
	private resolveApiKey?: LoadedByokConfig["getApiKey"];
	private lastError?: string;

	constructor(options: LoadByokConfigOptions, private readonly applyConfig: (config: LoadedByokConfig) => void,
		private readonly readSettings?: () => SessionSettings) {
		this.selection = { ...options };
	}

	get modelName(): string { return this.config?.model.name ?? "模型未就绪"; }
	get hasConfig(): boolean { return this.config !== undefined; }
	get modelKeys(): string[] { return this.config ? Object.keys(this.config.models) : []; }

	resolveModel(reference: ModelReference): HarnessModelSettings {
		const config = this.config;
		if (!config || resolve(reference.configPath) !== config.configPath) throw new ByokConfigError("请先用 /config 加载该会话对应的配置文件。");
		const model = config.models[reference.modelKey];
		if (!model) throw new ByokConfigError(`当前配置已没有模型 ${reference.modelKey}。`);
		return { model: structuredClone(model), modelRef: { ...reference }, getApiKey: config.getApiKey };
	}

	selectModel(modelKey: string): ByokReloadResult {
		if (!this.config) return this.reload({ model: modelKey });
		const config = this.config;
		if (!Object.hasOwn(config.models, modelKey)) {
			const reason = `未找到 BYOK 模型 ${modelKey}。`;
			return { ok: false, reason, message: reason };
		}
		const getApiKey = this.resolveApiKey!;
		const candidate = { ...config, currentModel: modelKey, model: structuredClone(config.models[modelKey]!),
			thinking: this.readSettings?.().thinking ?? config.thinking,
			getApiKey: (requested: Parameters<LoadedByokConfig["getApiKey"]>[0] = modelKey) => getApiKey(requested) };
		this.applyConfig(candidate);
		this.config = candidate;
		this.selection = { ...this.selection, configPath: config.configPath, model: modelKey };
		this.lastError = undefined;
		return { ok: true, message: `已切换到 ${modelKey}。`, warnings: [] };
	}

	/** Validate the entire candidate before committing any change to the active session. No HTTP probes. */
	reload(change: Pick<LoadByokConfigOptions, "configPath" | "model"> = {}): ByokReloadResult {
		this.selection = { ...this.selection, ...change };
		const current = this.readSettings?.();
		const sameFile = change.configPath === undefined && this.config &&
			resolve(this.selection.cwd ?? process.cwd(), this.selection.configPath ?? (this.selection.env ?? process.env).CLI_AGENT_CONFIG ?? "byok.json") === this.config.configPath;
		if (sameFile && change.model === undefined && current?.modelRef?.configPath === this.config!.configPath) {
			this.selection.model = current.modelRef.modelKey;
		}
		let config: LoadedByokConfig;
		try {
			config = loadByokConfig(this.selection);
			if (sameFile && current) config.thinking = { ...current.thinking };
		} catch (error) {
			if (!(error instanceof ByokConfigError)) throw error;
			this.lastError = error.message;
			return { ok: false, reason: error.message, message: this.describe() };
		}

		// Commit only after application succeeds. Credentials and request encoding are resolved on use.
		this.applyConfig(config);
		this.config = config;
		this.resolveApiKey = config.getApiKey;
		this.lastError = undefined;
		return { ok: true, warnings: config.warnings,
			message: [`已加载 BYOK 配置 ${config.configPath}，当前模型：${config.currentModel}（${config.model.name}）。`, ...config.warnings].join("\n") };
	}

	describe(): string {
		const path = this.selection.configPath ?? (this.selection.env ?? process.env).CLI_AGENT_CONFIG ?? "byok.json";
		return [
			`BYOK 配置：${path.trim() ? resolve(this.selection.cwd ?? process.cwd(), path) : "（路径为空）"}`,
			...(this.lastError ? [`配置错误：${this.lastError}`] : []),
			this.config
				? `当前仍生效：${this.readSettings?.().modelRef?.modelKey ?? this.config.currentModel}（${this.config.configPath}）；会话已保留。`
				: "尚无可用模型配置；聊天与压缩需要先配置模型，会话管理仍可使用。",
			...(this.config ? [`模型键：${Object.keys(this.config.models).join("、")}`] : []),
			BYOK_RECOVERY_HELP,
		].join("\n");
	}
}
