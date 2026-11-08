import { spawn } from "node:child_process";
import { Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { type Static, Type } from "typebox";
import type { AgentTool } from "../../types.ts";
import { BashOutput, type BashOutputSummary } from "./bash-output.ts";

export const bashSchema = Type.Object({
	command: Type.String({ description: "Shell command to execute" }),
	timeout: Type.Optional(Type.Number({ description: "Timeout in seconds" })),
});

export type BashToolInput = Static<typeof bashSchema>;

export interface BashToolDetails extends Partial<BashOutputSummary> {
	exitCode: number | null;
	timedOut?: boolean;
	interrupted?: boolean;
	durationMs?: number;
	liveLines?: string[];
}

export function createBashTool(cwd: string): AgentTool<typeof bashSchema, BashToolDetails> {
	return {
		name: "bash",
		label: "bash",
		description: "Run a shell command in the working directory. Returns combined stdout and stderr. " +
			"Large output is saved to a local file; the result contains a head/tail preview, truncation metadata, " +
			"and zero-based, end-exclusive byte ranges in that file. Use read(path, offset, limit) to inspect omitted lines. " +
			"On Windows this uses cmd.exe.",
		parameters: bashSchema,
		async execute(_toolCallId, { command, timeout }, signal, onUpdate) {
			if (timeout !== undefined && (!Number.isFinite(timeout) || timeout <= 0)) {
				throw new Error("Invalid timeout: must be a positive number of seconds");
			}
			if (signal?.aborted) throw new Error("Command aborted");

			// Windows uses cmd.exe; broader platform command adaptation remains a separate issue.
			const child = process.platform === "win32"
				? spawn(command, { cwd, shell: process.env.ComSpec ?? "cmd.exe", windowsHide: true })
				: spawn("bash", ["-lc", command], { cwd });
			const output = new BashOutput(cwd), startedAt = Date.now();
			const decoders = { stdout: new StringDecoder("utf8"), stderr: new StringDecoder("utf8") };
			let timedOut = false, tail = "", totalLines = 0, finished = false;
			let updateTimer: NodeJS.Timeout | undefined, timer: NodeJS.Timeout | undefined;
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
			const stop = () => {
				if (process.platform === "win32" && child.pid) {
					// Killing only cmd.exe leaves its command holding the output pipes and cwd open.
					const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
					killer.once("error", () => { child.kill(); });
				} else child.kill();
			};
			const cleanup = () => {
				finished = true;
				if (updateTimer) clearTimeout(updateTimer);
				if (timer) clearTimeout(timer);
				signal?.removeEventListener("abort", stop);
			};
			let exit: { code: number | null; terminationSignal: NodeJS.Signals | null };
			let snapshot;
			try {
				exit = await new Promise<{ code: number | null; terminationSignal: NodeJS.Signals | null }>((resolve, reject) => {
					let code: number | null = null, terminationSignal: NodeJS.Signals | null = null;
					let failure: Error | undefined;
					let childClosed = false;
					const fail = (error: Error) => {
						if (failure) return;
						failure = error;
						stop(); sink.destroy();
						// Drain disconnected pipes until the terminated command closes them.
						child.stdout.unpipe(sink); child.stderr.unpipe(sink);
						child.stdout.resume(); child.stderr.resume();
						if (childClosed) reject(error);
					};
					sink.once("error", fail);
					child.once("error", fail);
					child.stdout.once("error", fail);
					child.stderr.once("error", fail);
					sink.once("finish", () => resolve({ code, terminationSignal }));
					child.once("close", (exitCode, exitSignal) => {
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
					signal?.addEventListener("abort", stop, { once: true });
					if (timeout !== undefined) timer = setTimeout(() => { timedOut = true; stop(); }, timeout * 1000);
				});
				snapshot = await output.finish();
			} catch (error) {
				await output.discard();
				throw error;
			} finally {
				cleanup();
			}
			const { text, ...summary } = snapshot;
			const interrupted = Boolean(signal?.aborted || (!timedOut && exit.terminationSignal));
			const metadata = { ...summary, exitCode: exit.code, timedOut, interrupted, durationMs: Date.now() - startedAt };
			const status = signal?.aborted ? "Command aborted" : timedOut ? `Command timed out after ${timeout} seconds`
				: exit.terminationSignal ? `Command terminated by signal ${exit.terminationSignal}` : `Command exited with code ${exit.code}`;
			const content = (text || "(no output)") + `\n\n[${status}]\n[bash_result]\n${JSON.stringify(metadata)}\n[/bash_result]` +
				(summary.truncated ? "\nThe output above is incomplete. Byte ranges refer to the raw saved file, start inclusive and end exclusive; " +
					"returnedBytes excludes metadata and omission markers. Use read with outputPath and 1-based offset/limit to inspect omitted lines." : "");
			// Keep the existing abort/error contract while retaining the partial log and metadata.
			if (signal?.aborted) throw new Error(content);
			return { content: [{ type: "text", text: content }], details: { ...metadata, liveLines: tail.split(/\r?\n/).slice(-5) } };
		},
	};
}
