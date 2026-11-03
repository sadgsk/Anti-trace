import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { PromptDraft } from "../../cli/input/prompt-draft.ts";
export interface FileQuery { query: string; start: number; end: number }
export function fileSuggestionQuery(draft: PromptDraft): FileQuery | null {
	const before = draft.text.slice(0, draft.cursor), match = /(?:^|\s)@([^\s@]*)$/u.exec(before);
	if (!match) return null;
	const start = draft.cursor - match[1]!.length - 1;
	if (draft.references.some(ref => ref.start < draft.cursor && ref.end > start)) return null;
	return { query: match[1]!.replace(/\\/g, "/"), start, end: draft.cursor };
}
const excluded = new Set([".git", "node_modules", "dist", ".workbuddy", ".next", "coverage", ".cli-agent"]);
function score(path: string, query: string): number {
	const value = path.toLowerCase(), needle = query.toLowerCase();
	if (!needle) return 100 - path.length / 100;
	if (value === needle) return 10000;
	const position = value.indexOf(needle);
	if (position >= 0) return 1000 - position * 2 - path.length / 100;
	let cursor = 0, points = 0, previous = -2;
	for (let i = 0; i < value.length && cursor < needle.length; i++) if (value[i] === needle[cursor]) {
		points += i === 0 || /[/_.-]/.test(value[i - 1]!) ? 10 : i === previous + 1 ? 5 : 1;
		previous = i; cursor++;
	}
	return cursor === needle.length ? points - path.length / 100 : -Infinity;
}
/** Lazy, bounded index; no symlink traversal or persistent filesystem watcher. */
export class WorkspaceFileIndex {
	private paths: string[] = [];
	private loadedAt = 0;
	private loading?: Promise<void>;
	constructor(private readonly cwd: string) {}
	async search(query: string, limit = 50): Promise<string[]> {
		if (!this.loading && Date.now() - this.loadedAt > 5000) this.loading = this.scan().finally(() => { this.loading = undefined; });
		await this.loading;
		return this.paths.map(path => ({ path, score: score(path, query) })).filter(item => Number.isFinite(item.score))
			.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path)).slice(0, limit).map(item => item.path);
	}
	private async scan(): Promise<void> {
		const paths: string[] = [], queue = [""];
		while (queue.length && paths.length < 30000) {
			const directory = queue.shift()!;
			try {
				const entries = await readdir(join(this.cwd, directory), { withFileTypes: true });
				for (const entry of entries) {
					if (paths.length >= 30000) break;
					const relative = directory ? `${directory}/${entry.name}` : entry.name;
					if (entry.isDirectory() && !excluded.has(entry.name) && relative !== "test/artifacts") queue.push(relative);
					else if (entry.isFile()) paths.push(relative);
				}
			} catch { /* A deleted or unreadable directory does not disable other suggestions. */ }
		}
		this.paths = paths; this.loadedAt = Date.now();
	}
}
