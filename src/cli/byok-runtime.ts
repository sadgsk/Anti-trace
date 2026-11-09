import { join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { loadByokConfig, type LoadedByokConfig, type LoadByokConfigOptions } from "../config/byok.ts";
import { ByokConfigError } from "../config/errors.ts";
import type { ModelReference, SessionSettings } from "../types.ts";
import type { HarnessModelSettings } from "../harness/harness.ts";
import { ConfigProfiles, type ProfileEdit } from "../config/config-profiles.ts";
import { parseByokConfig } from "../config/byok.ts";
import { ModelSelectionStore } from "../config/model-selection.ts";
import { ensureProjectDirectory, getAppPaths, type AppPaths } from "../storage/app-paths.ts";

export const BYOK_RECOVERY_HELP = "输入 /config 管理配置，/model 选择模型，/reload 重新加载，/exit 退出。";

export type ByokReloadResult = { ok: true; message: string; warnings: string[] } | { ok: false; reason: string; message: string };
export interface ByokRuntimeOptions extends LoadByokConfigOptions { paths?: AppPaths }

/** Loads and applies configuration; does not own the Harness or its lifecycle. */
export class ByokRuntime {
	private selection: LoadByokConfigOptions;
	private config?: LoadedByokConfig;
	private resolveApiKey?: LoadedByokConfig["getApiKey"];
	private lastError?: string;
	private readonly selectionStore: ModelSelectionStore;
	private readonly defaultSelectionStore: ModelSelectionStore;
	private readonly paths: AppPaths;
	private startupWarnings: string[] = [];
	private readonly rememberDefaultOnStartup: boolean;
	private needsConfigChoice = false;
	readonly profiles: ConfigProfiles;

	constructor(options: ByokRuntimeOptions, private readonly applyConfig: (config: LoadedByokConfig) => void,
		private readonly readSettings?: () => SessionSettings) {
		const cwd = resolve(options.cwd ?? process.cwd());
		const env = options.env ?? process.env;
		this.paths = options.paths ?? getAppPaths({ ...options, cwd });
		this.selectionStore = new ModelSelectionStore(this.paths.projectSelectionFile, cwd);
		this.defaultSelectionStore = new ModelSelectionStore(this.paths.defaultSelectionFile, cwd);
		this.profiles = new ConfigProfiles(cwd, env, this.paths);
		const projectSaved = this.selectionStore.read();
		const explicitPath = options.configPath ?? env.CLI_AGENT_CONFIG;
		this.rememberDefaultOnStartup = explicitPath !== undefined || options.model !== undefined || !projectSaved;
		let saved: ModelReference | undefined;
		if (explicitPath === undefined) {
			for (const candidate of [projectSaved, this.defaultSelectionStore.read()]) {
				if (!candidate) continue;
				if (existsSync(candidate.configPath)) { saved = candidate; break; }
				this.startupWarnings.push(`记住的配置文件已不存在：${candidate.configPath}；已尝试其他默认配置。`);
			}
		} else if (projectSaved?.configPath === resolve(cwd, explicitPath)) saved = projectSaved;
		let configPath = explicitPath ?? saved?.configPath;
		const defaultPath = join(this.paths.configsDir, "main.json");
		if (configPath === undefined) {
			try {
				const profiles = this.profiles.list(defaultPath).filter(profile => profile.valid);
				if (profiles.length === 1) configPath = profiles[0]!.path;
				if (profiles.length > 1) this.needsConfigChoice = true;
			} catch { /* Keep startup diagnostics available if profile discovery fails. */ }
		}
		configPath ??= defaultPath;
		const savedModel = configPath !== undefined && saved?.configPath === resolve(cwd, configPath) ? saved.modelKey : undefined;
		this.selection = { ...options, cwd, configPath, model: options.model ?? savedModel };
	}

	get modelName(): string { return this.config?.model.name ?? "模型未就绪"; }
	get hasConfig(): boolean { return this.config !== undefined; }
	get modelKeys(): string[] { return this.config ? Object.keys(this.config.models) : []; }
	get configPath(): string { return this.config?.configPath ?? resolve(this.selection.cwd ?? process.cwd(), this.selection.configPath ?? (this.selection.env ?? process.env).CLI_AGENT_CONFIG ?? join(this.paths.configsDir, "main.json")); }
	get selectedModel(): string | undefined { return this.readSettings?.().modelRef?.modelKey ?? this.config?.currentModel; }
	get modelChoices() { return Object.entries(this.config?.models ?? {}).map(([key, model]) => ({ id: key, label: model.name, description: `${key} · ${model.id}`, current: key === this.selectedModel })); }
	saveProfile(values: Record<string, string>, edit?: ProfileEdit): string[] {
		const candidate = this.profiles.prepare(values, edit);
		const config = parseByokConfig(candidate.text, candidate.path, this.selection.env ?? process.env);
		const undo = this.profiles.write(candidate.path, candidate.text);
		try { this.applyConfig(config); } catch (error) { undo(); throw error; }
		this.config = config; this.resolveApiKey = config.getApiKey; this.lastError = undefined;
		return this.rememberSelection(config);
	}

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
		this.lastError = undefined;
		return { ok: true, message: `已切换到 ${modelKey}。`, warnings: this.rememberSelection(candidate) };
	}

	/** Validate the entire candidate before committing any change to the active session. No HTTP probes. */
	reload(change: Pick<LoadByokConfigOptions, "configPath" | "model"> = {}): ByokReloadResult {
		if (change.configPath !== undefined) this.needsConfigChoice = false;
		this.selection = { ...this.selection, ...change };
		if (change.configPath !== undefined && !Object.hasOwn(change, "model")) this.selection.model = undefined;
		const current = this.readSettings?.();
		const sameFile = change.configPath === undefined && this.config &&
			resolve(this.selection.cwd ?? process.cwd(), this.selection.configPath ?? (this.selection.env ?? process.env).CLI_AGENT_CONFIG ?? join(this.paths.configsDir, "main.json")) === this.config.configPath;
		if (sameFile && change.model === undefined && current?.modelRef?.configPath === this.config!.configPath) {
			this.selection.model = current.modelRef.modelKey;
		}
		let config: LoadedByokConfig;
		try {
			if (this.needsConfigChoice && !this.config) throw new ByokConfigError("存在多个模型配置，请用 /config 选择配置文件。");
			config = loadByokConfig(this.selection);
			if (sameFile && current) config.thinking = { ...current.thinking };
		} catch (error) {
			if (!(error instanceof ByokConfigError)) throw error;
			this.lastError = error.message;
			return { ok: false, reason: error.message, message: this.describe() };
		}

		const updateDefault = change.configPath !== undefined || change.model !== undefined ||
			(!this.config && (this.rememberDefaultOnStartup || !this.defaultSelectionStore.read()));
		// Commit only after application succeeds. Credentials and request encoding are resolved on use.
		this.applyConfig(config);
		this.config = config;
		this.resolveApiKey = config.getApiKey;
		this.lastError = undefined;
		const warnings = [...this.startupWarnings, ...config.warnings, ...this.rememberSelection(config, updateDefault)];
		this.startupWarnings = [];
		return { ok: true, warnings,
			message: [`已加载 BYOK 配置 ${config.configPath}，当前模型：${config.currentModel}（${config.model.name}）。`, ...warnings].join("\n") };
	}

	private rememberSelection(config: LoadedByokConfig, updateDefault = true): string[] {
		this.selection = { ...this.selection, configPath: config.configPath, model: config.currentModel };
		const reference = { configPath: config.configPath, modelKey: config.currentModel };
		let projectSaved = false;
		try { ensureProjectDirectory(this.paths); projectSaved = this.selectionStore.save(reference); } catch { /* Preferences are best effort. */ }
		const defaultSaved = !updateDefault || this.defaultSelectionStore.save(reference);
		return projectSaved && defaultSaved ? []
			: ["配置和模型选择保存失败；本次仍可使用，重启后可能需要重新选择。"];
	}

	describe(): string {
		const path = this.selection.configPath ?? (this.selection.env ?? process.env).CLI_AGENT_CONFIG ?? join(this.paths.configsDir, "main.json");
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
