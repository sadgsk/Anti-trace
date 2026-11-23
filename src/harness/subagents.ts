import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Type } from "typebox";
import type { AgentMessage, AgentTool, SessionSettings, ToolCall, ToolResultMessage } from "../types.ts";
import { appendEntry, loadSession, readSessionRows, sessionNeedsTailRepair, SESSION_VERSION, type SessionFile, type SessionHeader } from "./session.ts";

export interface SubagentSettings extends SessionSettings {
	modelId?: string;
	modelProvider?: string;
}

export interface SubagentRun {
	agentId: string;
	prompt: string;
	settings: SubagentSettings;
	session: SessionFile;
	messages: AgentMessage[];
	signal: AbortSignal;
}

interface Options {
	settings(agentId: string): SubagentSettings;
	prepareResume?(agentId: string, settings: SubagentSettings): void;
	run(context: SubagentRun): Promise<string>;
	hasSteering(): boolean;
	subscribeSteering(listener: () => void): () => void;
}

interface TaskHeader extends SessionHeader {
	parentSessionId: string;
	toolCallId: string;
	prompt: string;
	modelId?: string;
	modelProvider?: string;
}

type Outcome = { status: "running" | "paused" } | { status: "failed"; error: string } | { status: "completed"; report: string };
type ControlResult = { agent_id: string; status: Outcome["status"] | "interrupted"; error?: string; report?: string };

interface Task {
	header: TaskHeader;
	settings: SubagentSettings;
	path: string;
	state: Outcome;
	run?: { controller: AbortController; done: Promise<void> };
	writeError?: Error;
	listeners: Set<() => void>;
}

function result(details: ControlResult) {
	return { content: [{ type: "text" as const, text: JSON.stringify(details) }], details };
}

function readState(rows: unknown[]): Outcome {
	// A transcript created before an interrupted start is still recoverable.
	let state: Outcome = { status: "running" };
	for (const row of rows) {
		const value = row as Record<string, unknown>;
		if (value.type !== "subagent_state") continue;
		if (value.status === "completed" && typeof value.report === "string") state = { status: "completed", report: value.report };
		else if (value.status === "failed" && typeof value.error === "string") state = { status: "failed", error: value.error };
		else if (value.status === "running" || value.status === "paused") state = { status: value.status };
		else throw new Error("Invalid subagent state");
	}
	return state;
}

/** Only the trailing batch can still be executing when the writer stops. */
function pendingCalls(messages: AgentMessage[]): ToolCall[] {
	const answered = new Set<string>();
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role === "toolResult") answered.add(message.toolCallId);
		else if (message.role === "assistant") {
			return message.content.filter((block): block is ToolCall => block.type === "toolCall" && !!block.id && !answered.has(block.id));
		} else break;
	}
	return [];
}

function repairedResult(call: ToolCall, recovered?: ControlResult): ToolResultMessage {
	return {
		role: "toolResult", toolCallId: call.id, toolName: call.name, timestamp: Date.now(),
		isError: !recovered,
		...(recovered ? result(recovered) : { content: [{ type: "text", text: "Execution outcome unknown after interruption. Verify external effects before continuing. 执行结果未知，继续前请核对。" }] }),
	};
}

function resumableMessages(messages: AgentMessage[]): AgentMessage[] {
	// Calls from an incomplete model response never reached the executor. Keep the audit
	// transcript on disk and omit both sides of that batch from the next model request.
	let incompleteTurn = false;
	return messages.filter(message => {
		if (message.role !== "toolResult") incompleteTurn = message.role === "assistant" &&
			(message.stopReason === "aborted" || message.stopReason === "error");
		return !incompleteTurn;
	});
}

const idSchema = Type.String({ minLength: 1, description: "Task ID from this parent session" });
const taskSchema = Type.Object({
	action: Type.Union([Type.Literal("start"), Type.Literal("pause"), Type.Literal("resume")]),
	prompt: Type.Optional(Type.String({ minLength: 1, description: "Required for start. Include goal, context, scope and expected report." })),
	agent_id: Type.Optional(idSchema),
}, { additionalProperties: false });
const waitSchema = Type.Object({ agent_id: idSchema }, { additionalProperties: false });

export class SubagentManager {
	private readonly parent: SessionFile;
	private readonly options: Options;
	private readonly directory: string;
	private readonly tasks = new Map<string, Task>();
	private readonly creationIds = new Map<string, Task>();
	private ownerPath?: string;
	private accepting = true;
	private closed = false;

	constructor(parent: SessionFile, options: Options) {
		this.parent = parent;
		this.options = options;
		if (!/^[a-zA-Z0-9_-]+$/.test(parent.header.id)) throw new Error("Invalid parent session ID");
		this.directory = join(dirname(parent.path), parent.header.id, "subagents");
		if (existsSync(this.directory)) {
			this.acquireOwner();
			this.releaseIdleClaim();
		}
	}

	private restoreTasks() {
		for (const entry of readdirSync(this.directory, { withFileTypes: true })) {
			if (!entry.isFile() || !/^agent-[a-zA-Z0-9_-]+\.jsonl$/.test(entry.name)) continue;
			const path = join(this.directory, entry.name);
			const rows = readSessionRows(path, true);
			const loaded = loadSession(path, rows);
			const header = rows[0] as TaskHeader;
			if (entry.name !== `agent-${header.id}.jsonl` || header.parentSessionId !== this.parent.header.id ||
				header.cwd !== this.parent.header.cwd || typeof header.prompt !== "string" || typeof header.toolCallId !== "string" || !loaded.settings)
				throw new Error(`Invalid subagent transcript: ${path}`);
			const settings = { ...loaded.settings, modelId: header.modelId, modelProvider: header.modelProvider };
			const task: Task = { path, header, settings, state: readState(rows), listeners: new Set() };
			this.remember(task);
			if (task.state.status !== "running") continue;
			const file = { header, path, entries: loaded.entries, flushed: true };
			for (const call of pendingCalls(loaded.messages)) appendEntry(file, { type: "message", message: repairedResult(call) });
			this.commit(task, { status: "paused" });
		}
	}

	/** Each contender publishes a unique claim before testing its peers. A stale PID is never a lock to steal. */
	private acquireOwner() {
		if (this.ownerPath) return;
		mkdirSync(this.directory, { recursive: true, mode: 0o700 });
		const name = `.owner-${process.pid}-${randomUUID()}`;
		const path = join(this.directory, name);
		writeFileSync(path, "", { flag: "wx", mode: 0o600 });
		try {
			for (const other of readdirSync(this.directory)) {
				const match = /^\.owner-(\d+)-[\da-f-]+$/.exec(other);
				if (!match || other === name) continue;
				try { process.kill(Number(match[1]), 0); }
				catch (error) {
					if ((error as NodeJS.ErrnoException).code === "ESRCH") {
						try { unlinkSync(join(this.directory, other)); }
						catch (cleanupError) { if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") throw cleanupError; }
						continue;
					}
				}
				throw new Error("Another active session owns these subagents. Close it before resuming.");
			}
			this.restoreTasks();
			this.ownerPath = path;
		} catch (error) {
			this.tasks.clear();
			this.creationIds.clear();
			unlinkSync(path);
			throw error;
		}
	}

	private releaseOwner() {
		if (this.ownerPath) unlinkSync(this.ownerPath);
		this.ownerPath = undefined;
	}

	private remember(task: Task) {
		if (this.creationIds.has(task.header.toolCallId)) throw new Error("Duplicate subagent creation tool call ID");
		this.tasks.set(task.header.id, task);
		this.creationIds.set(task.header.toolCallId, task);
	}

	/** Protect parent call/result pairing until its submission ends, including the first start. */
	claimForToolBatch(): void {
		if (this.closed) throw new Error("This session is closed");
		this.acquireOwner();
	}

	releaseIdleClaim(): void {
		if (!this.tasks.size) this.releaseOwner();
	}

	recoverParent(messages: AgentMessage[]): void {
		if (!this.parent.flushed) return;
		if (!pendingCalls(messages).length && !sessionNeedsTailRepair(this.parent.path)) return;
		this.acquireOwner();
		try {
			// Another writer may have finished between the original read and our exclusive claim.
			const latest = loadSession(this.parent.path, readSessionRows(this.parent.path, true));
			this.parent.entries = latest.entries;
			messages.length = 0;
			for (const message of latest.messages) messages.push(message);
			for (const call of pendingCalls(messages)) {
				let recovered: ControlResult | undefined;
				if (call.name === "agent_task" && call.arguments.action === "start") {
					const task = this.creationIds.get(call.id);
					// A start result acknowledges creation; its report belongs only to wait_agent.
					if (task) recovered = this.status(task);
				} else if (call.name === "wait_agent" && typeof call.arguments.agent_id === "string") {
					recovered = { agent_id: call.arguments.agent_id, status: "interrupted" };
				}
				const message = repairedResult(call, recovered);
				appendEntry(this.parent, { type: "message", message });
				messages.push(message);
			}
		} finally { this.releaseIdleClaim(); }
	}

	tools(): AgentTool[] {
		const control: AgentTool<typeof taskSchema> = {
			name: "agent_task", label: "Manage subagent", parameters: taskSchema,
			description: "Delegate an independent task asynchronously with start and prompt. Pause or resume it using its agent_id. Pause is recoverable. Only wait_agent retrieves a report.",
			execute: async (callId, args, signal) => {
				signal?.throwIfAborted();
				if (args.action === "start") {
					if (!args.prompt?.trim()) throw new Error("agent_task start requires a nonempty prompt");
					return result(this.start(callId, args.prompt));
				}
				if (!args.agent_id) throw new Error(`agent_task ${args.action} requires agent_id`);
				const task = this.lookup(args.agent_id);
				return result(await (args.action === "pause" ? this.pause(task) : this.resume(task)));
			},
		};
		const wait: AgentTool<typeof waitSchema> = {
			name: "wait_agent", label: "Wait for subagent", parameters: waitSchema,
			description: "Wait for a task and read its final report. A paused task needs resume. User input may interrupt this wait while the task continues.",
			execute: async (_callId, { agent_id }, signal) => result(await this.wait(this.lookup(agent_id), signal)),
		};
		return [control, wait];
	}

	private lookup(id: string): Task {
		if (!this.ownerPath && !this.closed && existsSync(this.directory)) this.acquireOwner();
		const task = this.tasks.get(id);
		if (!task) throw new Error(`Unknown subagent in this session: ${id}`);
		if (task.writeError) throw task.writeError;
		return task;
	}

	private assertAccepting() {
		if (!this.accepting || this.closed) throw new Error("This session is stopping its subagents");
	}

	private status(task: Task): ControlResult {
		if (task.writeError) throw task.writeError;
		return { agent_id: task.header.id, status: task.state.status };
	}

	private start(toolCallId: string, prompt: string): ControlResult {
		this.assertAccepting();
		this.acquireOwner();
		const existing = this.creationIds.get(toolCallId);
		if (existing) return this.status(existing);
		const id = randomUUID();
		const path = join(this.directory, `agent-${id}.jsonl`);
		const settings = structuredClone(this.options.settings(id));
		const { thinking, modelRef, modelId, modelProvider } = settings;
		const header: TaskHeader = { type: "session", version: SESSION_VERSION, id, parentSessionId: this.parent.header.id,
			toolCallId, prompt, cwd: this.parent.header.cwd, timestamp: new Date().toISOString(), modelId, modelProvider };
		const state: Outcome = { status: "running" };
		// Rename exposes all the information needed to resume together, even on a process crash.
		const rows = [header, { type: "settings", thinking: { enabled: thinking.enabled, effort: thinking.effort },
			modelRef: modelRef && { configPath: modelRef.configPath, modelKey: modelRef.modelKey } },
			{ type: "message", message: { role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() } },
			{ type: "subagent_state", ...state }];
		const temp = path + ".tmp";
		writeFileSync(temp, rows.map(row => JSON.stringify(row)).join("\n") + "\n", { flag: "wx", mode: 0o600 });
		renameSync(temp, path);
		const task: Task = { header, path, settings, state, listeners: new Set() };
		this.remember(task);
		this.launch(task);
		return this.status(task);
	}

	private launch(task: Task) {
		const controller = new AbortController();
		const done = Promise.resolve().then(async () => {
			let outcome: Outcome;
			try {
				controller.signal.throwIfAborted();
				const loaded = loadSession(task.path);
				const report = await this.options.run({
					agentId: task.header.id, prompt: task.header.prompt, signal: controller.signal,
					settings: structuredClone(task.settings),
					session: { path: task.path, header: task.header, entries: loaded.entries, flushed: true },
					messages: resumableMessages(loaded.messages),
				});
				outcome = { status: "completed", report };
			} catch (error) {
				outcome = { status: "failed", error: error instanceof Error ? error.message : String(error) };
			}
			try {
				if (controller.signal.aborted) {
					const loaded = loadSession(task.path);
					const file = { path: task.path, header: task.header, entries: loaded.entries, flushed: true };
					for (const call of pendingCalls(loaded.messages)) appendEntry(file, { type: "message", message: repairedResult(call) });
					outcome = { status: "paused" };
				}
				this.commit(task, outcome);
			} catch (error) {
				task.writeError = error instanceof Error ? error : new Error(String(error));
			} finally {
				task.run = undefined;
				for (const notify of task.listeners) notify();
			}
		});
		task.run = { controller, done };
	}

	private commit(task: Task, state: Outcome) {
		appendFileSync(task.path, JSON.stringify({ type: "subagent_state", ...state }) + "\n");
		task.state = state;
	}

	private async pause(task: Task): Promise<ControlResult> {
		const run = task.run;
		if (!run) return this.status(task);
		run.controller.abort();
		await run.done;
		if (task.writeError) throw task.writeError;
		return { agent_id: task.header.id, status: "paused" };
	}

	private async resume(task: Task) {
		this.assertAccepting();
		if (task.run?.controller.signal.aborted) await task.run.done;
		this.assertAccepting();
		if (task.writeError) throw task.writeError;
		if (task.state.status === "paused") {
			// A missing or changed model is recoverable. Validate before publishing running.
			this.options.prepareResume?.(task.header.id, task.settings);
			this.commit(task, { status: "running" });
			this.launch(task);
		}
		return this.status(task);
	}

	private wait(task: Task, signal?: AbortSignal): Promise<ControlResult> {
		return new Promise((resolve, reject) => {
			let unsubscribe: (() => void) | undefined;
			let settled = false;
			const cleanup = () => {
				settled = true;
				task.listeners.delete(check);
				unsubscribe?.();
				signal?.removeEventListener("abort", check);
			};
			const check = () => {
				if (settled) return;
				if (task.writeError || signal?.aborted) {
					cleanup();
					reject(task.writeError ?? signal?.reason);
				} else if (task.state.status !== "running") {
					cleanup();
					resolve({ agent_id: task.header.id, ...task.state });
				} else if (this.options.hasSteering()) {
					cleanup();
					resolve({ agent_id: task.header.id, status: "interrupted" });
				}
			};
			check();
			if (settled) return;
			task.listeners.add(check);
			signal?.addEventListener("abort", check, { once: true });
			unsubscribe = this.options.subscribeSteering(check);
			if (settled) unsubscribe();
			else check();
		});
	}

	catalog(): string {
		if (!this.tasks.size) return "";
		const lines = [...this.tasks.values()].map(task =>
			`${task.header.id} [${task.state.status}] ${JSON.stringify(task.header.prompt.replace(/\s+/g, " ").slice(0, 120))}`);
		return ["Subagents in this session (ID, status, task summary):", ...lines].join("\n");
	}

	hasActiveRuns(): boolean { return [...this.tasks.values()].some(task => task.run); }
	allowRuns(): void { if (!this.closed) this.accepting = true; }

	async pauseAll(): Promise<void> {
		this.accepting = false;
		const settled = await Promise.allSettled([...this.tasks.values()].map(task => this.pause(task)));
		for (const outcome of settled) if (outcome.status === "rejected") throw outcome.reason;
	}

	closeIdle(): void {
		if (this.hasActiveRuns()) throw new Error("Cannot release a session with active subagents");
		this.closed = true;
		this.accepting = false;
		this.releaseOwner();
		for (const task of this.tasks.values()) if (task.writeError) throw task.writeError;
	}

	close(): Promise<void> {
		this.closed = true;
		return this.pauseAll().finally(() => this.releaseOwner());
	}
}
