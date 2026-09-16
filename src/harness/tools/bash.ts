import { spawn } from "node:child_process";
import { type Static, Type } from "typebox";
import type { AgentTool } from "../../types.ts";

export const bashSchema = Type.Object({
	command: Type.String({ description: "Shell command to execute" }),
	timeout: Type.Optional(Type.Number({ description: "Timeout in seconds" })),
});

export type BashToolInput = Static<typeof bashSchema>;

export interface BashToolDetails {
	exitCode: number | null;
	timedOut?: boolean;
}

export function createBashTool(cwd: string): AgentTool<typeof bashSchema, BashToolDetails> {
	return {
		name: "bash",
		label: "bash",
		description:
			"Run a shell command in the working directory. Returns combined stdout and stderr. On Windows this uses cmd.exe.",
		parameters: bashSchema,
		async execute(_toolCallId, { command, timeout }, signal) {
			if (timeout !== undefined && (!Number.isFinite(timeout) || timeout <= 0)) {
				throw new Error("Invalid timeout: must be a positive number of seconds");
			}

			// Windows 走 cmd.exe（相对 Pi 的改动）。没有在 prompt / 工具说明里做 LLM 平台适配，
			// 模型在 Windows 上仍可能发 rm/ls/find 等 bash 命令，导致失败或卡住。见 docs/future-issues.md No.1。
			const child =
				process.platform === "win32"
					? spawn(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", command], {
							cwd,
							windowsHide: true,
						})
					: spawn("bash", ["-lc", command], { cwd });

			let timedOut = false;
			const chunks: Buffer[] = [];

			const output = await new Promise<string>((resolve, reject) => {
				const onAbort = () => {
					child.kill();
					reject(new Error("Command aborted"));
				};

				if (signal?.aborted) {
					onAbort();
					return;
				}
				signal?.addEventListener("abort", onAbort, { once: true });

				const timer =
					timeout === undefined
						? undefined
						: setTimeout(() => {
								timedOut = true;
								child.kill();
							}, timeout * 1000);

				child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
				child.stderr.on("data", (chunk: Buffer) => chunks.push(chunk));
				child.on("error", (error) => {
					if (timer) clearTimeout(timer);
					signal?.removeEventListener("abort", onAbort);
					reject(error);
				});
				child.on("close", (code) => {
					if (timer) clearTimeout(timer);
					signal?.removeEventListener("abort", onAbort);
					const text = Buffer.concat(chunks).toString("utf8");
					if (signal?.aborted) {
						reject(new Error("Command aborted"));
						return;
					}
					const suffix = timedOut
						? `\n\n[Command timed out after ${timeout} seconds]`
						: code === 0 || code === null
							? ""
							: `\n\n[Command exited with code ${code}]`;
					resolve((text || "(no output)") + suffix);
				});
			});

			return {
				content: [{ type: "text", text: output }],
				details: { exitCode: child.exitCode, timedOut: timedOut || undefined },
			};
		},
	};
}
