import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { ModelReference } from "../types.ts";

/** A selection file contains only catalog references, never credentials. */
export class ModelSelectionStore {
	private readonly path: string;
	constructor(path: string, private readonly cwd: string = process.cwd()) {
		this.path = resolve(path);
	}

	read(): ModelReference | undefined {
		try {
			const value = JSON.parse(readFileSync(this.path, "utf8"));
			if (value?.version !== 1 || typeof value.configPath !== "string" || !value.configPath.trim()
				|| typeof value.modelKey !== "string" || !value.modelKey.trim()) return;
			return { configPath: resolve(this.cwd, value.configPath), modelKey: value.modelKey };
		} catch { return; } // First launch and malformed preferences use the normal startup defaults.
	}

	/** Failure to save a preference must not prevent the selected model from working now. */
	save(reference: ModelReference): boolean {
		const selection = { configPath: resolve(this.cwd, reference.configPath), modelKey: reference.modelKey };
		const previous = this.read();
		if (previous?.configPath === selection.configPath && previous.modelKey === selection.modelKey) return true;
		const temporary = `${this.path}.${randomUUID()}.tmp`;
		try {
			mkdirSync(dirname(this.path), { recursive: true });
			writeFileSync(temporary, JSON.stringify({ version: 1, ...selection }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
			renameSync(temporary, this.path);
			return true;
		} catch { return false; }
		finally { try { unlinkSync(temporary); } catch { /* Renamed or never created. */ } }
	}
}
