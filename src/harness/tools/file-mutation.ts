import { readlink, realpath, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { Static, TSchema } from "typebox";
import type { AgentTool } from "../../types.ts";

// Parent and child agents share a process. Resolve existing symlinks, including
// parent directories of files that a write is about to create.
async function canonicalPath(path: string, remainingLinks = 40): Promise<string> {
	try { return await realpath(path); }
	catch (error) {
		const parent = dirname(path);
		if ((error as NodeJS.ErrnoException).code !== "ENOENT" || parent === path) throw error;
		const directory = await canonicalPath(parent, remainingLinks);
		const entry = join(directory, basename(path));
		let target: string;
		try { target = await readlink(entry); }
		catch (linkError) {
			const code = (linkError as NodeJS.ErrnoException).code;
			if (code === "ENOENT" || code === "EINVAL") return entry;
			throw linkError;
		}
		// writeFile follows a dangling symlink and can create its target.
		if (!remainingLinks) throw new Error(`Too many symbolic links resolving ${path}`);
		return canonicalPath(resolve(directory, target), remainingLinks - 1);
	}
}

export async function fileAccessKey(cwd: string, path: string): Promise<string> {
	const absolute = resolve(cwd, path);
	try {
		const info = await stat(absolute, { bigint: true });
		// Hard links have different paths but share the file being read or modified.
		if (info.isFile() && info.nlink > 1n) return `inode:${info.dev}:${info.ino}`;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	const canonical = await canonicalPath(absolute);
	return process.platform === "win32" ? canonical.toLowerCase() : canonical;
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

async function acquireFileLock(cwd: string, path: string, signal?: AbortSignal): Promise<() => void> {
	if (signal?.aborted) throw new Error("Aborted");
	const key = await fileAccessKey(cwd, path);
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
		execute: tool.execute, release: await acquireFileLock(cwd, target(args), signal),
	});
	return {
		...tool, acquireExecution,
		executionMode: "parallel",
		getFileAccess: async args => [{ path: await fileAccessKey(cwd, target(args)), mode: "write" }],
		// Direct tool callers use the same lock as calls made through the agent loop.
		async execute(id, args, signal, onUpdate) {
			const reservation = await acquireExecution(args, signal);
			try { return await tool.execute(id, args, signal, onUpdate); }
			finally { reservation.release(); }
		},
	};
}
