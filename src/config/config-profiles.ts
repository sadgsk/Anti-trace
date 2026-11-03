import { existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { loadByokConfig, parseByokConfig, type ByokConfigDocument } from "./byok.ts";
import { ByokConfigError } from "./errors.ts";

export interface ConfigProfileField { key: string; label: string; value: string; secret?: boolean; placeholder?: string; options?: readonly string[] }

export interface ConfigProfile { path: string; name: string; valid: boolean }
export interface ProfileEdit { path: string; document: ByokConfigDocument; modelKey: string; digest: string; adding?: boolean }
const protocols = ["openai-completions", "openai-responses", "anthropic-messages"] as const;
const adapters = ["默认", "openai", "anthropic", "deepseek", "kimi", "qwen", "glm", "grok", "gemini", "minimax"] as const;
const digest = (text: string) => createHash("sha256").update(text).digest("hex");

/** Only recognized BYOK documents and the explicitly selected file appear as profiles. */
export class ConfigProfiles {
	readonly directory: string;
	constructor(private readonly cwd: string, private readonly env: NodeJS.ProcessEnv) { this.directory = join(resolve(cwd), ".ant-trace", "configs"); }
	list(currentPath: string): ConfigProfile[] {
		const paths = new Set([resolve(currentPath), join(resolve(this.cwd), "byok.json")]);
		for (const directory of new Set([this.directory, dirname(currentPath)])) {
			if (!existsSync(directory)) continue;
			for (const entry of readdirSync(directory, { withFileTypes: true })) {
				if (!entry.isFile() || !entry.name.endsWith(".json") || entry.name.includes(".example.")) continue;
				const path = join(directory, entry.name);
				try {
					const raw = JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
					if (raw?.version === 1 && raw.connections && raw.models) paths.add(path);
				} catch { /* Unrelated or malformed JSON is not a discovered profile. */ }
			}
		}
		return [...paths].filter(path => existsSync(path)).map(path => {
			try { loadByokConfig({ configPath: path, env: this.env }); return { path, name: basename(path), valid: true }; }
			catch { return { path, name: basename(path), valid: false }; }
		}).sort((a, b) => a.name.localeCompare(b.name));
	}
	read(path: string, modelKey?: string): ProfileEdit {
		const text = readFileSync(path, "utf8"), config = parseByokConfig(text, path, this.env);
		return { path, document: JSON.parse(text.replace(/^\uFEFF/, "")), modelKey: modelKey ?? config.currentModel, digest: digest(text) };
	}
	fields(edit?: ProfileEdit): ConfigProfileField[] {
		const model = edit?.adding ? undefined : edit?.document.models[edit.modelKey];
		const source = model ?? (edit ? edit.document.models[edit.document.currentModel] : undefined);
		const connection = source ? edit!.document.connections[source.connection] : undefined;
		const loaded = edit ? parseByokConfig(JSON.stringify(edit.document), edit.path, this.env, edit.adding ? edit.document.currentModel : edit.modelKey).model : undefined;
		return [
			{ key: "fileName", label: edit ? "配置文件名（改名将另存为）" : "配置文件名", value: edit ? basename(edit.path) : "", placeholder: "例如 main.json" },
			{ key: "baseUrl", label: "API URL", value: loaded?.endpoint ?? loaded?.baseUrl ?? "", placeholder: "https://api.example.com/v1" },
			{ key: "apiKey", label: "API Key", value: "", secret: true, placeholder: connection ? "已配置；留空保留" : "填写密钥" },
			{ key: "modelId", label: "模型 ID", value: model?.id ?? "" },
			{ key: "modelName", label: "模型显示名称", value: model?.name ?? "", placeholder: "留空使用模型 ID" },
			{ key: "api", label: "接口协议", value: loaded?.api ?? protocols[0], options: protocols },
			{ key: "adapter", label: "服务商适配", value: loaded?.adapter?.preset ?? "默认", options: adapters },
			{ key: "contextWindow", label: "上下文窗口（tokens）", value: String(model?.contextWindow ?? 262144) },
			{ key: "maxOutputTokens", label: "最大输出（tokens）", value: model?.maxOutputTokens ? String(model.maxOutputTokens) : "", placeholder: "可留空" },
		];
	}
	addModel(path: string): ProfileEdit {
		const edit = this.read(path);
		let index = 1; while (Object.hasOwn(edit.document.models, `model-${index}`)) index++;
		return { ...edit, modelKey: `model-${index}`, adding: true };
	}
	prepare(values: Record<string, string>, edit?: ProfileEdit): { path: string; text: string } {
		let name = values.fileName?.trim() ?? "";
		if (!name || /[<>:"/\\|?*\x00-\x1f]/u.test(name) || name === "." || name === ".." || /[. ]$/.test(name) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) throw new ByokConfigError("请填写有效的配置文件名，无需输入路径。");
		if (!name.endsWith(".json")) name += ".json";
		const path = edit && name === basename(edit.path) ? edit.path : join(this.directory, name);
		if (existsSync(path) && path !== edit?.path) throw new ByokConfigError("同名配置已存在，请更换文件名或从修改入口打开。");
		if (edit && digest(readFileSync(edit.path, "utf8")) !== edit.digest) throw new ByokConfigError("配置文件已被其他程序修改，请返回后重新打开。");
		if (!values.modelId?.trim()) throw new ByokConfigError("请填写模型 ID。");
		if (!edit && !values.apiKey?.trim()) throw new ByokConfigError("请填写 API Key。");
		const integer = (value: string | undefined, label: string) => {
			if (!value || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) <= 0) throw new ByokConfigError(`${label}必须为正整数。`);
			return Number(value);
		};
		const document: ByokConfigDocument = edit ? structuredClone(edit.document) : { version: 1, connections: {}, models: {}, currentModel: "main" };
		const modelKey = edit?.modelKey ?? "main", oldModel = edit?.adding ? undefined : document.models[modelKey];
		const sourceModel = oldModel ?? (edit ? document.models[edit.document.currentModel] : undefined);
		let connectionKey = sourceModel?.connection ?? "main";
		const connection = structuredClone(document.connections[connectionKey] ?? {});
		if (Object.entries(document.models).some(([key, model]) => key !== modelKey && model.connection === connectionKey)) {
			connectionKey = `${connectionKey}-${randomUUID().slice(0, 8)}`;
		}
		delete connection.preset;
		connection.api = values.api as typeof protocols[number];
		const url = values.baseUrl?.trim() ?? "";
		// The form accepts both an API root and a complete inference endpoint.
		if (/\/(chat\/completions|responses|messages)\/*$/.test(url)) {
			connection.endpoint = url; connection.baseUrl = url.replace(/\/(chat\/completions|responses|messages)\/*$/, "");
		} else { connection.baseUrl = url; delete connection.endpoint; }
		const adapterChanged = values.adapter !== (edit ? this.fields(edit).find(field => field.key === "adapter")!.value : "默认");
		if (adapterChanged || !edit) connection.adapter = values.adapter === "默认" ? undefined : { preset: values.adapter as NonNullable<typeof connection.adapter>["preset"] };
		// Preserve inherited preset rules when editing without changing the adapter choice.
		else if (edit && sourceModel && edit.document.connections[sourceModel.connection]?.preset) connection.adapter = parseByokConfig(JSON.stringify(edit.document), edit.path, this.env, edit.adding ? edit.document.currentModel : modelKey).model.adapter;
		if (values.apiKey?.trim()) { connection.apiKey = values.apiKey.trim(); delete connection.apiKeyEnv; }
		document.connections[connectionKey] = connection;
		document.models[modelKey] = { ...oldModel, connection: connectionKey, id: values.modelId.trim(), name: values.modelName?.trim() || values.modelId.trim(),
			contextWindow: integer(values.contextWindow, "上下文窗口"), maxOutputTokens: values.maxOutputTokens?.trim() ? integer(values.maxOutputTokens.trim(), "最大输出") : undefined };
		if (edit?.adding && !adapterChanged && sourceModel?.adapter) document.models[modelKey]!.adapter = structuredClone(sourceModel.adapter);
		if (adapterChanged) delete document.models[modelKey]!.adapter;
		document.currentModel = modelKey;
		const text = `${JSON.stringify(document, null, 2)}\n`;
		parseByokConfig(text, path, this.env);
		return { path, text };
	}
	/** Atomic replacement; returns an undo operation used if applying the model fails. */
	write(path: string, text: string): () => void {
		const previous = existsSync(path) ? readFileSync(path) : undefined;
		mkdirSync(dirname(path), { recursive: true });
		const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
		try { writeFileSync(temporary, text, { flag: "wx", mode: 0o600 }); renameSync(temporary, path); }
		finally { if (existsSync(temporary)) unlinkSync(temporary); }
		return () => { if (previous) writeFileSync(path, previous, { mode: 0o600 }); else unlinkSync(path); };
	}
}
