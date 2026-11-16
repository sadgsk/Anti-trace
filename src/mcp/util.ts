import { createHash, randomUUID } from "node:crypto";
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { McpError, type McpDiagnostic } from "./types.ts";

export const MCP_LIMITS = Object.freeze({ configBytes: 1024 * 1024, messageBytes: 8 * 1024 * 1024,
	catalogBytes: 4 * 1024 * 1024, catalogItems: 4096, catalogPages: 64, stderrBytes: 32768,
	concurrentConnections: 4, probeMs: 2000, cleanupMs: 4000, loginMs: 180000 });
export function digest(value: unknown): string { return createHash("sha256").update(typeof value === "string" ? value : stableJson(value)).digest("hex"); }
export function stableJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	if (value && typeof value === "object") return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k,v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(",")}}`;
	return JSON.stringify(value) ?? "null";
}
export function freeze<T>(value: T): T {
	if (value && typeof value === "object" && !Object.isFrozen(value)) { for (const item of Object.values(value)) freeze(item); Object.freeze(value); }
	return value;
}
export function atomicWrite(path: string, text: string, privateDirectory = false): void {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	if (privateDirectory && process.platform !== "win32") chmodSync(dirname(path), 0o700);
	if (privateDirectory && process.platform === "win32") {
		const system32 = join(process.env.SystemRoot ?? "C:\\Windows", "System32");
		const identity = execFileSync(join(system32, "whoami.exe"), ["/user", "/fo", "csv", "/nh"], { encoding: "utf8", windowsHide: true, timeout: 3000 });
		const sid = identity.match(/S-1-\d+(?:-\d+)+/)?.[0];
		if (!sid) throw new McpError("config", "无法确认 MCP 凭据文件的当前用户权限。");
		execFileSync(join(system32, "icacls.exe"), [dirname(path), "/inheritance:r", "/grant:r", `*${sid}:(OI)(CI)F`], { stdio: "ignore", windowsHide: true, timeout: 3000 });
	}
	const temp = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
	try { const fd = openSync(temp, "wx", 0o600); try { writeFileSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); } renameSync(temp, path); }
	finally { if (existsSync(temp)) unlinkSync(temp); }
}
/** No remote error body is included in a diagnostic. Known local messages and credential-free status codes suffice. */
export function diagnostic(error: unknown): McpDiagnostic {
	if (error instanceof McpError) return { code: error.code, message: error.message };
	if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) return { code: error.name === "AbortError" ? "cancelled" : "timeout", message: error.name === "AbortError" ? "MCP 操作已取消。" : "MCP 操作超时。" };
	return { code: "transport", message: "MCP 操作失败，请检查连接和服务器配置。" };
}
export function throwCancelled(signal?: AbortSignal): void { if (signal?.aborted) throw signal.reason instanceof McpError ? signal.reason : new McpError("cancelled", "MCP 操作已取消。"); }
export function deadline(timeoutMs: number, ...signals: (AbortSignal | undefined)[]) {
	const controller = new AbortController();
	const abort = (signal: AbortSignal) => controller.abort(signal.reason);
	const cleanups = signals.filter((s): s is AbortSignal => Boolean(s)).map(signal => {
		if (signal.aborted) abort(signal);
		const listener = () => abort(signal); signal.addEventListener("abort", listener, { once: true });
		return () => signal.removeEventListener("abort", listener);
	});
	const timer = setTimeout(() => controller.abort(new McpError("timeout", "MCP 操作超时。")), timeoutMs); timer.unref();
	return { signal: controller.signal, dispose() { clearTimeout(timer); cleanups.forEach(cleanup => cleanup()); } };
}
export async function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (signal?.aborted) { void promise.catch(() => {}); throwCancelled(signal); } if (!signal) return promise;
	let listener: () => void = () => {};
	try { return await Promise.race([promise, new Promise<never>((_, reject) => { listener = () => { try { throwCancelled(signal); } catch (e) { reject(e); } }; signal.addEventListener("abort", listener, { once: true }); })]); }
	finally { signal.removeEventListener("abort", listener); }
}
/** A cancelled waiter only aborts shared work when it was the last waiter. */
export class SharedTask<T> {
	readonly controller = new AbortController();
	readonly promise: Promise<T>;
	private waiters = 0;
	private settled = false;
	constructor(run: (signal: AbortSignal) => Promise<T>) {
		this.promise = Promise.resolve().then(() => { throwCancelled(this.controller.signal); return run(this.controller.signal); })
			.finally(() => { this.settled = true; });
		void this.promise.catch(() => {});
	}
	async wait(signal?: AbortSignal): Promise<T> {
		this.waiters++;
		try { return await abortable(this.promise, signal); }
		finally { if (--this.waiters === 0 && !this.settled) this.controller.abort(); }
	}
}
export function safeText(text: string, secrets: readonly string[] = []): string {
	let value = text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
	for (const secret of secrets.filter(Boolean).sort((a,b) => b.length-a.length)) value = value.split(secret).join("[REDACTED]");
	return value.replace(/((?:authorization|token|secret|password|api[_-]?key)\s*[:=]\s*)([^\s,;]+)/gi, "$1[REDACTED]").replace(/Bearer\s+[^\s,;]+/gi, "Bearer [REDACTED]");
}
