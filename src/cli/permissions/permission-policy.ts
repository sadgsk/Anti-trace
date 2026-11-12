import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { BeforeToolCallContext, BeforeToolCallResult } from "../../types.ts";
import type { InputTarget } from "../input/input-dispatcher.ts";
import { TextInputController } from "../input/text-input-controller.ts";
import { buildDiff, type StructuredDiffHunk } from "../../harness/tools/diff.ts";

export type PermissionMode = "default" | "auto-edit" | "yolo";
export const isShellTool = (name: string) => name === "bash" || name === "powershell";
const commandKey = (name: string, args: Record<string, unknown>) => JSON.stringify([name, String(args.command)]);
export interface PermissionRequest { id: string; name: string; args: Record<string, unknown>; hunks?: StructuredDiffHunk[]; previewError?: string }
export interface PermissionSnapshot { mode: PermissionMode; request: PermissionRequest | null; selectedIndex: number; editingFeedback: boolean }
export interface SkillPermissionAccess { permissionTools(name: string): readonly string[] | undefined; activeTools(): readonly string[] }

export class PermissionPolicy {
	private snapshot: PermissionSnapshot;
	private readonly listeners = new Set<() => void>();
	private readonly allowedCommands = new Set<string>();
	private readonly allowedSkills = new Set<string>();
	private allowEdits = false;
	private pending?: (result: BeforeToolCallResult | undefined) => void;
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
	private allowed(name: string, args: Record<string, unknown>) {
		return name === "read" || this.snapshot.mode === "yolo" || this.skills?.activeTools().includes(name)
			|| (name === "skill" && this.skills && (!(this.skills.permissionTools(String(args.skill))?.length) || this.allowedSkills.has(this.skillKey(args))))
			|| ((name === "edit" || name === "write") && (this.snapshot.mode === "auto-edit" || this.allowEdits))
			|| (isShellTool(name) && this.allowedCommands.has(commandKey(name, args)));
	}
	private skillKey(args: Record<string, unknown>): string { return JSON.stringify([args.skill, this.skills?.permissionTools(String(args.skill))]); }
	cycleMode(): void {
		const modes: PermissionMode[] = ["default", "auto-edit", "yolo"];
		this.update({ mode: modes[(modes.indexOf(this.snapshot.mode) + 1) % modes.length]! });
		const request = this.snapshot.request;
		if (request && this.allowed(request.name, request.args)) this.decide("allow");
	}
	resetSession(): void { this.cancel(); this.allowEdits = false; this.allowedCommands.clear(); this.allowedSkills.clear(); }
	move(direction: number): void { this.update({ selectedIndex: (this.snapshot.selectedIndex + direction + 3) % 3 }); }
	accept(): void {
		if (this.snapshot.editingFeedback) { this.decide("deny"); return; }
		if (this.snapshot.selectedIndex === 2) { this.feedback.replaceText(""); this.update({ editingFeedback: true }); }
		else this.decide(this.snapshot.selectedIndex === 1 ? "session" : "allow");
	}
	decide(decision: "allow" | "session" | "deny"): void {
		const request = this.snapshot.request;
		if (!request || !this.pending) return;
		if (decision === "session") {
			if (["edit", "write"].includes(request.name)) this.allowEdits = true;
			else if (isShellTool(request.name)) this.allowedCommands.add(commandKey(request.name, request.args));
			else if (request.name === "skill") this.allowedSkills.add(this.skillKey(request.args));
		}
		const settle = this.pending; this.pending = undefined;
		const reason = this.feedback.getSnapshot().state.text.trim() || "用户拒绝执行此工具。";
		this.update({ request: null, editingFeedback: false });
		settle(decision === "deny" ? { block: true, reason } : undefined);
	}
	cancel(): void { this.decide("deny"); }
	dispose(): void { this.cancel(); this.feedback.dispose(); this.listeners.clear(); }
	beforeToolCall = async (context: BeforeToolCallContext, signal?: AbortSignal): Promise<BeforeToolCallResult | undefined> => {
		const name = context.toolCall.name, args = context.args as Record<string, unknown>;
		if (signal?.aborted) return { block: true, reason: "已中断。" };
		if (this.allowed(name, args)) return undefined;
		if (!this.interactive) return { block: true, reason: "非交互模式无法请求权限；请在终端审批，或显式使用 --yolo。" };
		const request: PermissionRequest = { id: context.toolCall.id, name, args: name === "skill" ? { ...args, allowedTools: this.skills?.permissionTools(String(args.skill)) ?? [] } : args };
		if (name === "edit" || name === "write") {
			try {
				const path = resolve(this.cwd, String(args.path));
				let original = "";
				try { original = await readFile(path, { encoding: "utf8", signal }); }
				catch (error) { if (name !== "write" || !(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error; }
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
		}
		if (signal?.aborted) return { block: true, reason: "已中断。" };
		// Mode may have changed while the file preview was being read.
		if (this.allowed(name, args)) return undefined;
		return new Promise(resolveDecision => {
			const onAbort = () => this.cancel();
			this.pending = result => { signal?.removeEventListener("abort", onAbort); resolveDecision(result); };
			signal?.addEventListener("abort", onAbort, { once: true });
			this.feedback.replaceText("");
			this.update({ request, selectedIndex: 0, editingFeedback: false });
			if (signal?.aborted) this.cancel();
		});
	};
}
