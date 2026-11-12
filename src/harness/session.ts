import { randomUUID } from "node:crypto";
import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, readdirSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { AgentMessage, ImageContent, SessionSettings, UserMessage } from "../types.ts";
import { THINKING_LEVELS } from "../llm/rules.ts";
import { extensionForImageMimeType } from "./tools/image.ts";
import { canonicalWorkspace, ensureProjectDirectory, getAppPaths, projectIdForCwd, type AppPaths } from "../storage/app-paths.ts";

export type SessionStorage = string | AppPaths;

/** A string is an explicit root used by embedders/tests; normal CLI calls supply resolved paths. */
export function sessionDirForCwd(cwd: string, storage?: SessionStorage): string {
	return typeof storage === "string" ? join(resolve(storage), projectIdForCwd(cwd)) : (storage ?? getAppPaths({ cwd })).sessionsDir;
}

export const SESSION_VERSION = 1 as const;

export interface SessionHeader {
	type: "session";
	version: typeof SESSION_VERSION;
	id: string;
	timestamp: string;
	cwd: string;
	name?: string;
}

export interface SessionMessageEntry {
	type: "message";
	message: AgentMessage;
}

export interface CompactionEntry {
	type: "compaction";
	summary: string;
	keptMessages: AgentMessage[];
	skillMessages?: UserMessage[];
	tokensBefore?: number;
	/** Recovery superseded the failed assistant immediately before this boundary. */
	replacesError?: boolean;
}

export interface SessionSettingsEntry extends SessionSettings { type: "settings" }
export type SessionEntry = SessionMessageEntry | CompactionEntry | SessionSettingsEntry;

export interface SessionFile {
	storage?: AppPaths;
	path: string;
	header: SessionHeader;
	entries: SessionEntry[];
	flushed: boolean;
}

export function createSessionFile(cwd: string, storage?: SessionStorage): SessionFile {
	storage ??= getAppPaths({ cwd });
	const id = randomUUID();
	const timestamp = new Date().toISOString();
	const resolvedCwd = resolve(cwd);
	const header: SessionHeader = {
		type: "session",
		version: SESSION_VERSION,
		id,
		timestamp,
		cwd: resolvedCwd,
	};
	const fileTimestamp = timestamp.replace(/[:.]/g, "-");
	return {
		path: join(sessionDirForCwd(resolvedCwd, storage), `${fileTimestamp}_${id}.jsonl`),
		...(typeof storage === "string" ? {} : { storage }),
		header,
		entries: [],
		flushed: false,
	};
}

export function sessionTitleFromUserText(text: string): string {
	const normalized = text.replace(/\s+/g, " ").trim();
	if (normalized.length === 0) {
		return "untitled";
	}
	return normalized.slice(0, 10);
}

export function appendEntry(session: SessionFile, entry: SessionEntry): void {
	if (session.flushed) {
		// Keep in-memory settings unchanged when a persisted append fails.
		appendFileSync(session.path, `${JSON.stringify(entry)}\n`);
		session.entries.push(entry);
		return;
	}
	session.entries.push(entry);

	const hasAssistant = session.entries.some(
		(item) => item.type === "message" && item.message.role === "assistant",
	);
	if (!hasAssistant) {
		return;
	}

	if (!session.flushed) {
		if (session.header.name === undefined) {
			let userText = "";
			for (const item of session.entries) {
				if (item.type !== "message" || item.message.role !== "user" || item.message.isMeta) {
					continue;
				}
				userText = item.message.content
					.filter((block): block is { type: "text"; text: string } => block.type === "text")
					.map((block) => block.text)
					.join("");
				break;
			}
			session.header.name = sessionTitleFromUserText(userText);
		}
		if (session.storage) ensureProjectDirectory(session.storage);
		mkdirSync(dirname(session.path), { recursive: true, mode: 0o700 });
		const fd = openSync(session.path, "wx", 0o600);
		try {
			writeFileSync(fd, `${JSON.stringify(session.header)}\n`);
			for (const item of session.entries) {
				writeFileSync(fd, `${JSON.stringify(item)}\n`);
			}
		} finally {
			closeSync(fd);
		}
		session.flushed = true;
		return;
	}

}

export interface LoadedSession {
	header: SessionHeader;
	name: string;
	messages: AgentMessage[];
	entries: SessionEntry[];
	settings?: SessionSettings;
}

export function loadSession(filePath: string): LoadedSession {
	const text = readFileSync(filePath, "utf8");
	let header: SessionHeader | undefined;
	const entries: SessionEntry[] = [];
	const messages: AgentMessage[] = [];
	let firstUserText = "";
	let settings: SessionSettings | undefined;

	for (const rawLine of text.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (line.length === 0) {
			continue;
		}
		const parsed: unknown = JSON.parse(line);
		if (typeof parsed !== "object" || parsed === null) {
			throw new Error(`Invalid session line in ${filePath}`);
		}
		const row = parsed as { type?: unknown };

		if (!header) {
			const candidate = parsed as SessionHeader;
			if (
				row.type !== "session" ||
				candidate.version !== SESSION_VERSION ||
				typeof candidate.id !== "string" ||
				typeof candidate.timestamp !== "string" ||
				typeof candidate.cwd !== "string"
			) {
				throw new Error(`Invalid session header: ${filePath}`);
			}
			header = {
				type: "session",
				version: SESSION_VERSION,
				id: candidate.id,
				timestamp: candidate.timestamp,
				cwd: candidate.cwd,
				name: typeof candidate.name === "string" ? candidate.name : undefined,
			};
			continue;
		}

		if (row.type === "settings") {
			const value = parsed as SessionSettingsEntry;
			if (!value.thinking || !THINKING_LEVELS.includes(value.thinking.effort) ||
				(value.thinking.enabled !== undefined && typeof value.thinking.enabled !== "boolean") ||
				(value.modelRef !== undefined && (!value.modelRef || typeof value.modelRef.configPath !== "string" ||
					!value.modelRef.configPath.trim() || typeof value.modelRef.modelKey !== "string" || !value.modelRef.modelKey.trim()))) {
				throw new Error(`Invalid settings entry in ${filePath}`);
			}
			// Whitelist persisted fields: session data must never supply credentials or URLs.
			settings = {
				thinking: { effort: value.thinking.effort, ...(value.thinking.enabled === undefined ? {} : { enabled: value.thinking.enabled }) },
				...(value.modelRef ? { modelRef: { configPath: value.modelRef.configPath, modelKey: value.modelRef.modelKey } } : {}),
			};
			entries.push({ type: "settings", ...settings });
			continue;
		}
		if (row.type === "message") {
			const message = (parsed as SessionMessageEntry).message;
			if (!message || typeof message.role !== "string") {
				throw new Error(`Invalid message entry in ${filePath}`);
			}
			entries.push({ type: "message", message });
			if (
				firstUserText.length === 0 &&
				message.role === "user" &&
				!message.isMeta &&
				Array.isArray(message.content)
			) {
				firstUserText = message.content
					.filter((block): block is { type: "text"; text: string } => block.type === "text")
					.map((block) => block.text)
					.join("");
			}
			messages.push(message);
			continue;
		}

		if (row.type === "compaction") {
			const compaction = parsed as CompactionEntry;
			if (typeof compaction.summary !== "string" || !Array.isArray(compaction.keptMessages)
				|| (compaction.skillMessages !== undefined && (!Array.isArray(compaction.skillMessages) || compaction.skillMessages.some(message => message?.role !== "user" || message.isMeta !== true || !Array.isArray(message.content))))
				|| (compaction.replacesError !== undefined && typeof compaction.replacesError !== "boolean")) {
				throw new Error(`Invalid compaction entry in ${filePath}`);
			}
			entries.push({
				type: "compaction",
				summary: compaction.summary,
				keptMessages: compaction.keptMessages,
				...(compaction.skillMessages ? { skillMessages: compaction.skillMessages } : {}),
				tokensBefore: compaction.tokensBefore,
				...(compaction.replacesError ? { replacesError: true } : {}),
			});
			const headerTime = Date.parse(header.timestamp);
			messages.length = 0;
			messages.push(
				{
					role: "user",
					content: [{ type: "text", text: compaction.summary }],
					timestamp: Number.isNaN(headerTime) ? 0 : headerTime,
				},
				...(compaction.skillMessages ?? []), ...compaction.keptMessages,
			);
		}
	}

	if (!header) {
		throw new Error(`Empty session file: ${filePath}`);
	}

	return {
		header,
		entries,
		messages,
		settings,
		name: header.name ?? sessionTitleFromUserText(firstUserText),
	};
}

export interface SessionListItem {
	filePath: string;
	name: string;
	lastOpenedAt: number;
}

export function listSessions(cwd: string, storage?: SessionStorage): SessionListItem[] {
	const dir = sessionDirForCwd(cwd, storage);
	let fileNames: string[];
	try {
		fileNames = readdirSync(dir);
	} catch {
		return [];
	}

	const items: SessionListItem[] = [];
	for (const fileName of fileNames) {
		if (!fileName.endsWith(".jsonl")) {
			continue;
		}
		const filePath = join(dir, fileName);
		let lastOpenedAt: number;
		try {
			lastOpenedAt = statSync(filePath).mtimeMs;
		} catch {
			continue;
		}
		let name: string;
		try {
			const loaded = loadSession(filePath);
			if (canonicalWorkspace(loaded.header.cwd) !== canonicalWorkspace(cwd)) continue;
			name = loaded.name;
		} catch {
			continue;
		}
		items.push({ filePath, name, lastOpenedAt });
	}

	items.sort((a, b) => b.lastOpenedAt - a.lastOpenedAt);
	return items;
}

export function findMostRecentSession(cwd: string, storage?: SessionStorage): string | undefined {
	return listSessions(cwd, storage)[0]?.filePath;
}

export function touchSession(filePath: string): void {
	const now = new Date();
	utimesSync(filePath, now, now);
}

/**
 * Write one image next to the session jsonl and return its absolute path.
 *
 * Images live inside the jsonl as base64, which the model cannot recover later: the line holding
 * one is megabytes long and `read` bails out on an oversized first line, and even when it does read
 * the line it sees base64 characters rather than an image. Keeping a real file next to the jsonl
 * gives the model a path it can `read` again after compaction drops the image from context.
 *
 * The bytes written are the ones that were put into context (already resized), so the file and the
 * model's view of it agree.
 */
export function saveSessionImage(sessionPath: string, image: ImageContent): string {
	const dir = `${sessionPath.replace(/\.jsonl$/, "")}.assets`;
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const filePath = join(dir, `${randomUUID()}.${extensionForImageMimeType(image.mimeType)}`);
	writeFileSync(filePath, Buffer.from(image.data, "base64"), { mode: 0o600 });
	return filePath;
}
