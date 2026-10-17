import { resolve } from "node:path";
import { loadByokConfig, type LoadedByokConfig, type LoadByokConfigOptions } from "../config/byok.ts";
import { ByokConfigError } from "../config/errors.ts";

export const BYOK_RECOVERY_HELP = "修改配置文件后输入 /reload 重试；/config <路径> 更换文件，/model <模型键> 重新选择，/exit 退出。";

export type ByokReloadResult = { ok: true; message: string; warnings: string[] } | { ok: false; reason: string; message: string };

/** Loads and applies configuration; does not own the Harness or its lifecycle. */
export class ByokRuntime {
	private selection: LoadByokConfigOptions;
	private config?: LoadedByokConfig;
	private lastError?: string;

	constructor(options: LoadByokConfigOptions, private readonly applyConfig: (config: LoadedByokConfig) => void) {
		this.selection = { ...options };
	}

	get modelName(): string { return this.config?.model.name ?? "模型未就绪"; }
	get hasConfig(): boolean { return this.config !== undefined; }
	get modelKeys(): string[] { return this.config ? Object.keys(this.config.models) : []; }

	/** Validate the entire candidate before committing any change to the active session. No HTTP probes. */
	reload(change: Pick<LoadByokConfigOptions, "configPath" | "model"> = {}): ByokReloadResult {
		this.selection = { ...this.selection, ...change };
		let config: LoadedByokConfig;
		try {
			config = loadByokConfig(this.selection);
		} catch (error) {
			if (!(error instanceof ByokConfigError)) throw error;
			this.lastError = error.message;
			return { ok: false, reason: error.message, message: this.describe() };
		}

		// Commit only after application succeeds. Credentials and request encoding are resolved on use.
		this.applyConfig(config);
		this.config = config;
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
				? `当前仍生效：${this.config.currentModel}（${this.config.configPath}）；会话已保留。`
				: "尚无可用模型配置；聊天与压缩需要先配置模型，会话管理仍可使用。",
			...(this.config ? [`模型键：${Object.keys(this.config.models).join("、")}`] : []),
			BYOK_RECOVERY_HELP,
		].join("\n");
	}
}
