import { spawn } from "node:child_process";
import { Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { win32 } from "node:path";
import { type Static, Type } from "typebox";
import type { AgentTool } from "../../types.ts";
import { BashOutput, type BashOutputSummary } from "./bash-output.ts";
import { ensureProjectDirectory, getAppPaths, type AppPaths } from "../../storage/app-paths.ts";

export const shellSchema = Type.Object({
	command: Type.String({ description: "Shell command to execute" }),
	timeout: Type.Optional(Type.Number({ description: "Timeout in seconds" })),
});

export type ShellToolInput = Static<typeof shellSchema>;
export const DEFAULT_SHELL_TIMEOUT_SECONDS = 120;
export interface ShellToolConfig {
	name: "bash" | "powershell"; path: string; args(command: string): string[]; description: string; defaultTimeout?: number;
}

export interface ShellToolDetails extends Partial<BashOutputSummary> {
	exitCode: number | null;
	timedOut?: boolean;
	interrupted?: boolean;
	durationMs?: number;
	liveLines?: string[];
	outputDrainTimedOut?: boolean;
}

export function createShellTool(cwd: string, config: ShellToolConfig, paths: AppPaths = getAppPaths({ cwd })): AgentTool<typeof shellSchema, ShellToolDetails> {
	return {
		name: config.name,
		label: config.name,
		description: config.description + " Returns combined stdout and stderr. " +
			"Large output is saved to a local file; the result contains a head/tail preview, truncation metadata, " +
			"and zero-based, end-exclusive byte ranges in that file. Use read(path, offset, limit) to inspect omitted lines. " +
			`The default timeout is ${config.defaultTimeout ?? DEFAULT_SHELL_TIMEOUT_SECONDS} seconds.`,
		parameters: shellSchema,
		async execute(_toolCallId, { command, timeout = config.defaultTimeout ?? DEFAULT_SHELL_TIMEOUT_SECONDS }, signal, onUpdate) {
			if (timeout !== undefined && (!Number.isFinite(timeout) || timeout <= 0)) {
				throw new Error("Invalid timeout: must be a positive number of seconds");
			}
			if (signal?.aborted) throw new Error("Command aborted");

			const child = spawn(config.path, config.args(command), {
				cwd, windowsHide: true, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"],
			});
			child.stdin.end();
			const childClosedPromise = new Promise<void>(resolve => child.once("close", () => resolve()));
			const output = new BashOutput(paths.toolResultsDir, config.name, () => ensureProjectDirectory(paths)), startedAt = Date.now();
			const decoders = { stdout: new StringDecoder("utf8"), stderr: new StringDecoder("utf8") };
			let timedOut = false, tail = "", totalLines = 0, finished = false;
			let updateTimer: NodeJS.Timeout | undefined, timer: NodeJS.Timeout | undefined, drainTimer: NodeJS.Timeout | undefined;
			let outputDrainTimedOut = false;
			const publish = () => {
				updateTimer = undefined;
				if (!finished) onUpdate?.({ content: [], details: { exitCode: null, liveLines: tail.split(/\r?\n/).slice(-5),
					totalLines, durationMs: Date.now() - startedAt } });
			};
			// Both pipes share a Writable: one write at a time, with backpressure on both sources.
			const sink = new Writable({ highWaterMark: 64 * 1024,
				write(chunk: Buffer, _encoding, callback) { output.append(chunk).then(() => callback(), callback); },
			});
			const progress = (stream: "stdout" | "stderr", chunk: Buffer) => {
				const text = decoders[stream].write(chunk);
				totalLines += text.split("\n").length - 1;
				tail = (tail + text).split(/\r?\n/).slice(-6).join("\n").slice(-16000);
				if (!updateTimer && onUpdate) updateTimer = setTimeout(publish, 80);
			};
			let termination: Promise<void> | undefined;
			const stop = () => termination ??= new Promise<void>(resolve => {
				if (process.platform === "win32" && child.pid) {
					// Once exited, this PID may be reused; never taskkill an unrelated process.
					if (child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
					// Terminate the shell and its descendants, including children holding output pipes.
					const killer = spawn(win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"), ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore", timeout: 2000 });
					killer.once("error", () => { child.kill("SIGKILL"); resolve(); });
					killer.once("close", code => { if (code !== 0) child.kill("SIGKILL"); resolve(); });
				} else if (child.pid) {
					try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
					resolve();
				}
				else resolve();
			});
			let removeAbort = () => {};
			const cleanup = () => {
				finished = true;
				if (updateTimer) clearTimeout(updateTimer);
				if (timer) clearTimeout(timer);
				if (drainTimer) clearTimeout(drainTimer);
				removeAbort();
			};
			let exit: { code: number | null; terminationSignal: NodeJS.Signals | null };
			let snapshot;
			try {
				exit = await new Promise<{ code: number | null; terminationSignal: NodeJS.Signals | null }>((resolve, reject) => {
					let code: number | null = null, terminationSignal: NodeJS.Signals | null = null;
					let failure: Error | undefined;
					let childClosed = false;
					let closeOutput: (() => void) | undefined;
					const fail = (error: Error) => {
						if (failure) return;
						failure = error;
						stop(); sink.destroy();
						// The log is being discarded; release pipes even if termination fails.
						child.stdout.unpipe(sink); child.stderr.unpipe(sink);
						child.stdout.destroy(); child.stderr.destroy();
						reject(error);
					};
					sink.once("error", fail);
					child.once("error", fail);
					child.stdout.once("error", fail);
					child.stderr.once("error", fail);
					sink.once("finish", () => resolve({ code, terminationSignal }));
					// A descendant may inherit pipes after the shell exits. Allow trailing bytes
					// to drain, then close the pipes rather than waiting forever for `close`.
					const boundDrain = () => {
						if (drainTimer) return;
						drainTimer = setTimeout(() => { outputDrainTimedOut = true; stop(); closeOutput?.(); }, 2000);
					};
					closeOutput = () => {
						if (childClosed) return;
						childClosed = true;
						child.stdout.unpipe(sink); child.stderr.unpipe(sink);
						child.stdout.destroy(); child.stderr.destroy();
						sink.end();
					};
					child.once("exit", (exitCode, exitSignal) => {
						code = exitCode; terminationSignal = exitSignal;
						if (timer) clearTimeout(timer);
						boundDrain();
					});
					child.once("close", (exitCode, exitSignal) => {
						if (childClosed) return;
						childClosed = true;
						if (timer) clearTimeout(timer);
						code = exitCode;
						terminationSignal = exitSignal;
						if (failure) reject(failure);
						else sink.end();
					});
					child.stdout.on("data", (chunk: Buffer) => progress("stdout", chunk));
					child.stderr.on("data", (chunk: Buffer) => progress("stderr", chunk));
					child.stdout.pipe(sink, { end: false });
					child.stderr.pipe(sink, { end: false });
					const cancel = () => { stop(); boundDrain(); };
					signal?.addEventListener("abort", cancel, { once: true });
					removeAbort = () => signal?.removeEventListener("abort", cancel);
					if (signal?.aborted) cancel();
					else timer = setTimeout(() => { timedOut = true; cancel(); }, timeout * 1000);
				});
				await termination;
				snapshot = await output.finish();
			} catch (error) {
				await stop();
				let deadline: NodeJS.Timeout | undefined;
				try { await Promise.race([childClosedPromise, new Promise<void>(resolve => { deadline = setTimeout(resolve, 2000); })]); }
				finally { if (deadline) clearTimeout(deadline); }
				await output.discard();
				throw error;
			} finally {
				cleanup();
			}
			const { text, ...summary } = snapshot;
			const interrupted = Boolean(signal?.aborted || (!timedOut && exit.terminationSignal) || outputDrainTimedOut);
			const metadata = { ...summary, exitCode: exit.code, timedOut, interrupted, durationMs: Date.now() - startedAt, ...(outputDrainTimedOut ? { outputDrainTimedOut: true } : {}) };
			const status = signal?.aborted ? "Command aborted" : timedOut ? `Command timed out after ${timeout} seconds`
				: outputDrainTimedOut ? "Command output pipes did not close; descendant output was interrupted"
				: exit.terminationSignal ? `Command terminated by signal ${exit.terminationSignal}` : `Command exited with code ${exit.code}`;
			const content = (text || "(no output)") + `\n\n[${status}]\n[${config.name}_result]\n${JSON.stringify(metadata)}\n[/${config.name}_result]` +
				(summary.truncated ? "\nThe output above is incomplete. Byte ranges refer to the raw saved file, start inclusive and end exclusive; " +
					"returnedBytes excludes metadata and omission markers. Use read with outputPath and 1-based offset/limit to inspect omitted lines." : "");
			// Keep the existing abort/error contract while retaining the partial log and metadata.
			if (signal?.aborted) throw new Error(content);
			return { content: [{ type: "text", text: content }], details: { ...metadata, liveLines: tail.split(/\r?\n/).slice(-5) } };
		},
	};
}
