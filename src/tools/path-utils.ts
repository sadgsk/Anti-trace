import path from "node:path";

export async function resolveCwdPath(cwd: string, inputPath: string, signal?: AbortSignal): Promise<string> {
	if (signal?.aborted) {
		throw new Error("Aborted");
	}

	return path.resolve(cwd, inputPath);
}
