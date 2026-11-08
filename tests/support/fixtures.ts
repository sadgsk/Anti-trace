import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { setTimeout } from "node:timers/promises";

/** Register cleanup immediately, including when an assertion fails. */
export function tempWorkspace(t: TestContext, beforeCleanup?: () => void | Promise<void>): string {
	const root = mkdtempSync(join(tmpdir(), "cli-agent-fixture-"));
	t.after(async () => {
		try { await beforeCleanup?.(); }
		finally { rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
	});
	return root;
}

export function deferred<T = void>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
	return { promise, resolve, reject };
}

export async function waitFor(predicate: () => boolean, description: string, timeoutMs = 5000): Promise<void> {
	const deadline = performance.now() + timeoutMs;
	while (!predicate()) {
		if (performance.now() >= deadline) throw new Error(`Timed out waiting for ${description}`);
		await setTimeout(10);
	}
}
