import { McpError, type McpCatalogItems, type McpCatalogKind, type McpCatalogSnapshot } from "./types.ts";
import { diagnostic, freeze, MCP_LIMITS, SharedTask, throwCancelled } from "./util.ts";

export class McpCatalog<K extends McpCatalogKind> {
	private snapshot: McpCatalogSnapshot<McpCatalogItems[K]> = freeze({ status: "unloaded", revision: 0, items: [] });
	private pending?: SharedTask<readonly McpCatalogItems[K][]>;
	constructor(readonly kind: K, private readonly publish: () => void) {}
	getSnapshot() { return this.snapshot; }
	unsupported() { this.set({ status: "unsupported", revision: this.snapshot.revision + 1, items: [] }); }
	invalidate() { if (this.snapshot.status !== "unsupported") this.set({ ...this.snapshot, status: "stale", revision: this.snapshot.revision + 1 }); }
	private set(value: McpCatalogSnapshot<McpCatalogItems[K]>) { this.snapshot = freeze(value); this.publish(); }
	async load(fetchPage: (cursor: string | undefined, signal: AbortSignal) => Promise<{ items: McpCatalogItems[K][]; nextCursor?: string }>, signal?: AbortSignal) {
		throwCancelled(signal);
		if (this.snapshot.status === "unsupported") throw new McpError("unsupported", "MCP 服务器不支持该目录。");
		if (this.snapshot.status === "ready") return this.snapshot.items;
		if (!this.pending || this.pending.controller.signal.aborted) {
			const revision = this.snapshot.revision;
			this.set({ ...this.snapshot, status: "loading", error: undefined });
			const task = new SharedTask(async loadSignal => {
				try {
					let cursor: string | undefined, bytes = 0;
					const cursors = new Set<string>(), identities = new Set<string>(), items: McpCatalogItems[K][] = [];
					for (let page = 0; page < MCP_LIMITS.catalogPages; page++) {
						throwCancelled(loadSignal);
						const result = await fetchPage(cursor, loadSignal);
						bytes += Buffer.byteLength(JSON.stringify(result));
						if (bytes > MCP_LIMITS.catalogBytes || items.length + result.items.length > MCP_LIMITS.catalogItems) throw new McpError("limit", "MCP 目录超过接收上限。");
						for (const item of result.items) {
							const key = "uri" in item ? item.uri : "uriTemplate" in item ? item.uriTemplate : item.name;
							if (identities.has(key)) throw new McpError("protocol", "MCP 目录包含重复标识。");
							identities.add(key); items.push(item);
						}
						if (result.nextCursor === undefined) {
							throwCancelled(loadSignal);
							if (this.snapshot.revision !== revision) throw new McpError("catalog-changed", "MCP 目录在读取期间发生变化，请重试。");
							this.set({ status: "ready", revision: revision + 1, items });
							return this.snapshot.items;
						}
						if (cursors.has(result.nextCursor)) throw new McpError("protocol", "MCP 目录分页游标重复。");
						cursors.add(result.nextCursor); cursor = result.nextCursor;
					}
					throw new McpError("limit", "MCP 目录分页超过上限。");
				} catch (error) {
					if (this.snapshot.revision === revision) this.set({ ...this.snapshot, status: "failed", error: diagnostic(error) });
					throw error;
				}
			});
			this.pending = task;
			void task.promise.finally(() => { if (this.pending === task) this.pending = undefined; }).catch(() => {});
		}
		return this.pending.wait(signal);
	}
	close() { this.pending?.controller.abort(); this.invalidate(); }
}
