import { realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { Static, TSchema } from "typebox";
import type { AgentTool } from "../../types.ts";

// Parent and child agents share a process. Resolve existing symlinks, including
// parent directories of files that a write is about to create.
async function canonicalPath(path: string): Promise<string> {
	try { return await realpath(path); }
	catch (error) {
		const parent = dirname(path);
		if ((error as NodeJS.ErrnoException).code !== "ENOENT" || parent === path) throw error;
		return join(await canonicalPath(parent), basename(path));
	}
}

type FileLockQueue = Array<() => void>;
// A path stays in this map while it is locked, even if nobody is waiting.
const lockQueuesByPath = new Map<string, FileLockQueue>();

function waitForFileLock(queue: FileLockQueue, signal?: AbortSignal): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		function grantLock() {
			signal?.removeEventListener("abort", cancelWait);
			resolve();
		}

		function cancelWait() {
			const index = queue.indexOf(grantLock);
			if (index !== -1) queue.splice(index, 1);
			reject(new Error("Aborted"));
		}

		queue.push(grantLock);
		signal?.addEventListener("abort", cancelWait, { once: true });
	});
}

async function acquireFileLock(path: string, signal?: AbortSignal): Promise<() => void> {
	if (signal?.aborted) throw new Error("Aborted");
	const canonical = await canonicalPath(path);
	const key = process.platform === "win32" ? canonical.toLowerCase() : canonical;
	if (signal?.aborted) throw new Error("Aborted");

	let queue = lockQueuesByPath.get(key);
	if (queue === undefined) {
		queue = [];
		lockQueuesByPath.set(key, queue);
	} else {
		await waitForFileLock(queue, signal);
	}

	return function releaseFileLock() {
		const grantNextLock = queue.shift();
		if (grantNextLock) {
			grantNextLock();
		} else {
			lockQueuesByPath.delete(key);
		}
	};
}

export function serializeFileMutations<P extends TSchema, D>(
	cwd: string, tool: AgentTool<P, D>, target: (args: Static<P>) => string,
): AgentTool<P, D> {
	const acquireExecution = async (args: Static<P>, signal?: AbortSignal) => ({
		execute: tool.execute, release: await acquireFileLock(resolve(cwd, target(args)), signal),
	});
	return {
		...tool, acquireExecution,
		// Direct tool callers use the same lock as calls made through the agent loop.
		async execute(id, args, signal, onUpdate) {
			const reservation = await acquireExecution(args, signal);
			try { return await tool.execute(id, args, signal, onUpdate); }
			finally { reservation.release(); }
		},
	};
}
