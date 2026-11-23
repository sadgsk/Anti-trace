import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import type { BeforeToolCallContext, BeforeToolCallResult, ToolPermission } from "../../types.ts";
import type { InputTarget } from "../input/input-dispatcher.ts";
import { TextInputController } from "../input/text-input-controller.ts";
import { buildDiff, type StructuredDiffHunk } from "../../harness/tools/diff.ts";

export type PermissionMode = "default" | "auto-edit" | "yolo";
export const isShellTool = (name: string) => name === "bash" || name === "powershell";
const commandKey = (name: string, args: Record<string, unknown>) => JSON.stringify([name, String(args.command)]);
export interface PermissionRequest { id: string; name: string; args: Record<string, unknown>; agentSource?: BeforeToolCallContext["agentSource"]; permission?: ToolPermission; hunks?: StructuredDiffHunk[]; previewError?: string; previewChanged?: boolean }
const permissionKey = (permission: ToolPermission) => JSON.stringify([permission.provider, permission.scopeKey, permission.actionKey]);
export interface PermissionSnapshot { mode: PermissionMode; request: PermissionRequest | null; selectedIndex: number; editingFeedback: boolean }
export type SkillPermissionAccess = NonNullable<BeforeToolCallContext["skillAccess"]>;
interface PendingApproval {
	request: PermissionRequest;
	skills?: SkillPermissionAccess;
	preview?: { controller: AbortController; reserve?: BeforeToolCallContext["reserveForApproval"]; loading: boolean; version?: string };
	settle(result?: BeforeToolCallResult): void;
}

export class PermissionPolicy {
	private snapshot: PermissionSnapshot;
	private readonly listeners = new Set<() => void>();
	private readonly allowedCommands = new Set<string>();
	private readonly allowedSkills = new Set<string>();
	private readonly allowedExternal = new Set<string>();
	private allowEdits = false;
	private readonly queue: PendingApproval[] = [];
	readonly feedback = new TextInputController({ availableColumns: 60 });
	readonly target: InputTarget;
	constructor(private readonly cwd: string, private readonly interactive: boolean, mode: PermissionMode = "default", private readonly skills?: SkillPermissionAccess) {
		this.snapshot = { mode, request: null, selectedIndex: 0, editingFeedback: false };
		this.target = { id: Symbol("permission"), context: "Permission", actions: {
			...this.feedback.target.actions,
			"permission:previous": () => { if (this.snapshot.editingFeedback) this.feedback.handleAction("input:up"); else this.move(-1); },
			"permission:next": () => { if (this.snapshot.editingFeedback) this.feedback.handleAction("input:down"); else this.move(1); },
			"permission:accept": () => this.accept(),
			"permission:cancel": () => this.snapshot.editingFeedback ? this.update({ editingFeedback: false }) : this.decide("deny"),
		}, onInput: event => {
			if (this.snapshot.editingFeedback) this.feedback.handleInput(event);
			else if (event.type === "text" && /^[123]$/.test(event.text)) { this.update({ selectedIndex: Number(event.text) - 1 }); this.accept(); }
		} };
	}
	getSnapshot = () => this.snapshot;
	subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
	private update(change: Partial<PermissionSnapshot>) { this.snapshot = { ...this.snapshot, ...change }; for (const listener of this.listeners) listener(); }
	private allowed(name: string, args: Record<string, unknown>, skills?: SkillPermissionAccess, permission?: ToolPermission) {
		if (permission) return this.snapshot.mode === "yolo" || this.allowedExternal.has(permissionKey(permission));
		return name === "read" || name === "agent_task" || name === "wait_agent" || this.snapshot.mode === "yolo" || skills?.activeTools().includes(name)
			|| (name === "skill" && skills && (!(skills.permissionTools(String(args.skill))?.length) || this.allowedSkills.has(this.skillKey(args, skills))))
			|| ((name === "edit" || name === "write") && (this.snapshot.mode === "auto-edit" || this.allowEdits))
			|| (isShellTool(name) && this.allowedCommands.has(commandKey(name, args)));
	}
	private skillKey(args: Record<string, unknown>, skills?: SkillPermissionAccess): string { return JSON.stringify([args.skill, skills?.permissionTools(String(args.skill))]); }
	cycleMode(): void {
		const modes: PermissionMode[] = ["default", "auto-edit", "yolo"];
		this.update({ mode: modes[(modes.indexOf(this.snapshot.mode) + 1) % modes.length]! });
		this.presentNext();
	}
	resetSession(): void {
		this.cancel(); this.allowEdits = false;
		this.allowedCommands.clear(); this.allowedSkills.clear(); this.allowedExternal.clear();
	}
	move(direction: number): void { this.update({ selectedIndex: (this.snapshot.selectedIndex + direction + 3) % 3 }); }
	accept(): void {
		if (this.snapshot.editingFeedback) { this.decide("deny"); return; }
		if (this.snapshot.selectedIndex === 2) { this.feedback.replaceText(""); this.update({ editingFeedback: true }); }
		else this.decide(this.snapshot.selectedIndex === 1 ? "session" : "allow");
	}
	decide(decision: "allow" | "session" | "deny"): void {
		const request = this.snapshot.request;
		const pending = this.queue[0];
		if (!request || request !== pending?.request) return;
		if (pending.preview && decision !== "deny") {
			void this.refreshPreview(pending, decision);
			return;
		}
		this.settleDecision(pending, decision);
	}
	private settleDecision(pending: PendingApproval, decision: "allow" | "session" | "deny"): void {
		const { request } = pending;
		if (decision === "session") {
			if (request.permission) this.allowedExternal.add(permissionKey(request.permission));
			else if (["edit", "write"].includes(request.name)) this.allowEdits = true;
			else if (isShellTool(request.name)) this.allowedCommands.add(commandKey(request.name, request.args));
			else if (request.name === "skill") this.allowedSkills.add(this.skillKey(request.args, pending.skills));
		}
		const reason = this.feedback.getSnapshot().state.text.trim() || "用户拒绝执行此工具。";
		this.queue.shift();
		pending.settle(decision === "deny" ? { block: true, reason } : undefined);
		this.presentNext();
	}
	private presentNext(): void {
		let next = this.queue[0];
		while (next && this.allowed(next.request.name, next.request.args, next.skills, next.request.permission)) {
			this.queue.shift();
			next.settle();
			next = this.queue[0];
		}
		if (next?.preview && next.preview.version === undefined) void this.refreshPreview(next);
		const request = next && (!next.preview || next.preview.version !== undefined) ? next.request : null;
		if (request !== this.snapshot.request) {
			this.feedback.replaceText("");
			this.update({ request, selectedIndex: 0, editingFeedback: false });
		}
	}
	cancel(): void {
		for (const pending of this.queue.splice(0)) pending.settle({ block: true, reason: "已中断。" });
		this.presentNext();
	}
	dispose(): void { this.cancel(); this.feedback.dispose(); this.listeners.clear(); }
	beforeToolCall = async (context: BeforeToolCallContext, signal?: AbortSignal): Promise<BeforeToolCallResult | undefined> => {
		const name = context.toolCall.name, args = context.args as Record<string, unknown>;
		const skills = context.skillAccess ?? (context.agentSource ? undefined : this.skills);
		if (signal?.aborted) return { block: true, reason: "已中断。" };
		if (this.allowed(name, args, skills, context.permission)) return undefined;
		if (!this.interactive) return { block: true, reason: "非交互模式无法请求权限；请在终端审批，或显式使用 --yolo。" };
		const request: PermissionRequest = { id: context.toolCall.id, name, agentSource: context.agentSource, permission: context.permission, args: name === "skill" ? { ...args, allowedTools: skills?.permissionTools(String(args.skill)) ?? [] } : args };
		return new Promise(resolveDecision => {
			const preview = name === "edit" || name === "write"
				? { controller: new AbortController(), reserve: context.reserveForApproval, loading: false } : undefined;
			const pending: PendingApproval = {
				request, skills, preview,
				settle: result => { preview?.controller.abort(); signal?.removeEventListener("abort", onAbort); resolveDecision(result); },
			};
			const onAbort = () => {
				const index = this.queue.indexOf(pending);
				if (index < 0) return;
				this.queue.splice(index, 1);
				pending.settle({ block: true, reason: "已中断。" });
				this.presentNext();
			};
			this.queue.push(pending);
			signal?.addEventListener("abort", onAbort, { once: true });
			this.presentNext();
		});
	};
	private async refreshPreview(pending: PendingApproval, decision?: "allow" | "session"): Promise<void> {
		const preview = pending.preview!;
		if (preview.loading) return;
		preview.loading = true;
		const signal = preview.controller.signal;
		if (preview.reserve && preview.version === undefined) {
			try { await preview.reserve(signal); }
			catch (error) {
				if (this.queue[0] === pending) {
					this.queue.shift();
					pending.settle({ block: true, reason: String(error) });
					this.presentNext();
				}
				return;
			}
			if (signal.aborted) return;
		}
		const request = { ...pending.request, hunks: undefined, previewError: undefined };
		const version = await this.preparePreview(request, signal, preview.version);
		preview.loading = false;
		if (this.queue[0] !== pending) return;
		if (decision && preview.version === version) {
			this.settleDecision(pending, decision);
			return;
		}
		pending.request = { ...request, previewChanged: decision !== undefined };
		preview.version = version;
		this.presentNext();
	}
	private async preparePreview(request: PermissionRequest, signal?: AbortSignal, previousVersion?: string): Promise<string> {
		const { name, args } = request;
		let version: string | undefined;
		try {
			const path = resolve(this.cwd, String(args.path));
			let original = "";
			try {
				const bytes = await readFile(path, { signal });
				version = createHash("sha256").update(bytes).digest("hex");
				if (version === previousVersion) return version;
				original = bytes.toString("utf8");
			} catch (error) {
				if (name !== "write" || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				version = "missing";
			}
			let after = String(args.content ?? "");
			if (name === "edit") {
				const edits = args.edits as { oldText: string; newText: string }[];
				const matches = edits.map(edit => {
					if (!edit.oldText || original.split(edit.oldText).length !== 2) throw new Error("替换内容与当前文件不唯一匹配。");
					return { ...edit, start: original.indexOf(edit.oldText) };
				}).sort((a, b) => a.start - b.start);
				for (let i = 1; i < matches.length; i++) if (matches[i - 1]!.start + matches[i - 1]!.oldText.length > matches[i]!.start) throw new Error("替换区域重叠。");
				after = original;
				for (const edit of matches.reverse()) after = after.slice(0, edit.start) + edit.newText + after.slice(edit.start + edit.oldText.length);
			}
			request.hunks = buildDiff(path, original, after).hunks;
		} catch (error) { request.previewError = error instanceof Error ? error.message : String(error); }
		return version ?? `error:${request.previewError}`;
	}
}
