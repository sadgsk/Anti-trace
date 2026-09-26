import type { AgentMessage, AssistantMessage, Context, Model, StreamFn } from "../types.ts";
import { estimateTokens } from "./context.ts";

/** Compaction thresholds and how much recent context to keep. */
export interface CompactionSettings {
	enabled: boolean;
	reserveTokens: number;
	keepRecentTokens: number;
}

export const DEFAULT_COMPACTION_SETTINGS: CompactionSettings = {
	enabled: true,
	reserveTokens: 16384,
	keepRecentTokens: 20000,
};

export function shouldCompact(used: number, window: number, settings: CompactionSettings): boolean {
	if (!settings.enabled) {
		return false;
	}
	return used > window - settings.reserveTokens;
}

/** Identify overflow replies that need compaction after a model turn. */
export function isContextOverflow(message: AssistantMessage, window: number): boolean {
	if (message.stopReason === "error") {
		return /exceeds? (?:the )?context window|maximum context length|context[_ ](?:window|length)[_ ]exceeded|prompt is too long/i.test(
			message.errorMessage ?? "",
		);
	}
	if (!message.usage) {
		return false;
	}
	if (message.stopReason === "stop") {
		return message.usage.input > window;
	}
	return (
		message.stopReason === "length" &&
		message.usage.output === 0 &&
		message.usage.input >= window * 0.99 &&
		!message.content.some((block) =>
			block.type === "toolCall" || (block.type === "text" && block.text.length > 0),
		)
	);
}

/**
 * Pick where the retained tail starts, as an index into `messages`.
 *
 * The cut only ever lands on a `user` message, so a turn is kept whole. Cutting at an
 * assistant or toolResult would leave a tool call without its tool result (or the reverse),
 * which the provider rejects.
 *
 * Returns 0 when the whole transcript is already within `keepRecentTokens` (nothing to
 * summarize) and `messages.length` when the tail has to be empty.
 */
export function findCutIndex(messages: readonly AgentMessage[], keepRecentTokens: number): number {
	if (keepRecentTokens <= 0) {
		return messages.length;
	}

	// suffixTokens[i] = estimated tokens of messages[i..end], so each cut candidate is O(1).
	const suffixTokens = new Array<number>(messages.length + 1).fill(0);
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		suffixTokens[index] = suffixTokens[index + 1] + (message ? estimateTokens(message) : 0);
	}

	// Walking backward returns the latest user whose tail already meets the budget, i.e. the
	// smallest whole-turn tail that satisfies it.
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		if (messages[index]?.role !== "user") {
			continue;
		}
		if (suffixTokens[index] >= keepRecentTokens) {
			return index;
		}
	}

	return 0;
}

// ---------------------------------------------------------------------------
// Summarization prompt
//
// The summary request replays the real messages and appends the instruction as one more user
// message, matching ZCode / Claude Code. It deliberately does NOT serialize the conversation to
// text or drop tool results: the request has to share a byte-identical prefix with the main
// conversation so the gateway's prompt cache covers it. Measured on the deepseek gateway, an
// identical prefix hits ~97% of the prompt while a rewritten one hits 0%, with a 50x price gap
// between cache-hit and cache-miss input.
//
// Consequence: the request carries the session's own system prompt and tools. The model may
// therefore answer with a tool call; `isToolCallReply` lets the caller fail that attempt.
// ---------------------------------------------------------------------------

// ZCode / Claude Code list their own tool names here; adapted to this project's four tools.
const NO_TOOLS_PREAMBLE = `CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.

- Do NOT use read, bash, edit, write, or ANY other tool.
- You already have all the context you need in the conversation above.
- Tool calls will be REJECTED and will waste your only turn — you will fail the task.
- Your entire response must be plain text: an <analysis> block followed by a <summary> block.

`;

const NO_TOOLS_TRAILER =
	"\n\nREMINDER: Do NOT call any tools. Respond with plain text only — " +
	"an <analysis> block followed by a <summary> block. " +
	"Tool calls will be rejected and you will fail the task.";

const BASE_COMPACT_PROMPT = `Your task is to create a detailed summary of the conversation so far, paying close attention to the user's explicit requests and your previous actions.
This summary should be thorough in capturing technical details, code patterns, and architectural decisions that would be essential for continuing development work without losing context.

Before providing your final summary, wrap your analysis in <analysis> tags to organize your thoughts and ensure you've covered all necessary points. In your analysis process:

1. Chronologically analyze each message and section of the conversation. For each section thoroughly identify:
   - The user's explicit requests and intents
   - Your approach to addressing the user's requests
   - Key decisions, technical concepts and code patterns
   - Specific details like:
     - file names
     - full code snippets
     - function signatures
     - file edits
   - Errors that you ran into and how you fixed them
   - Pay special attention to specific user feedback that you received, especially if the user told you to do something differently.
2. Double-check for technical accuracy and completeness, addressing each required element thoroughly.

Your summary should include the following sections:

1. Primary Request and Intent: Capture all of the user's explicit requests and intents in detail
2. Key Technical Concepts: List all important technical concepts, technologies, and frameworks discussed.
3. Files and Code Sections: Enumerate specific files and code sections examined, modified, or created. Pay special attention to the most recent messages and include full code snippets where applicable and include a summary of why this file read or edit is important.
4. Errors and fixes: List all errors that you ran into, and how you fixed them. Pay special attention to specific user feedback that you received, especially if the user told you to do something differently.
5. Problem Solving: Document problems solved and any ongoing troubleshooting efforts.
6. All user messages: List ALL user messages that are not tool results. These are critical for understanding the users' feedback and changing intent.
7. Pending Tasks: Outline any pending tasks that you have explicitly been asked to work on.
8. Current Work: Describe in detail precisely what was being worked on immediately before this summary request, paying special attention to the most recent messages from both user and assistant. Include file names and code snippets where applicable.
9. Optional Next Step: List the next step that you will take that is related to the most recent work you were doing. IMPORTANT: ensure that this step is DIRECTLY in line with the user's most recent explicit requests, and the task you were working on immediately before this summary request. If your last task was concluded, then only list next steps if they are explicitly in line with the users request. Do not start on tangential requests or really old requests that were already completed without confirming with the user first.

Here's an example of how your output should be structured:

<example>
<analysis>
[Your thought process, ensuring all points are covered thoroughly and accurately]
</analysis>

<summary>
1. Primary Request and Intent:
   [Detailed description]

2. Key Technical Concepts:
   - [Concept 1]
   - [Concept 2]
   - [...]

3. Files and Code Sections:
   - [File Name 1]
   - [Summary of why this file is important]
   - [Summary of the changes made to this file, if any]
   - [Important Code Snippet]
   - [...]

4. Errors and fixes:
   - [Detailed description of error 1]:
     - [How you fixed the error]
     - [User feedback on the error if any]
   - [...]

5. Problem Solving:
   [Description of solved problems and ongoing troubleshooting]

6. All user messages:
   - [Detailed non tool use user message]
   - [...]

7. Pending Tasks:
   - [Task 1]
   - [Task 2]
   - [...]

8. Current Work:
   [Precise description of current work]

9. Optional Next Step:
   [Optional Next step to take]
</summary>
</example>

Please provide your summary based on the conversation so far, following this structure and ensuring precision and thoroughness in your response.`;

/**
 * Build the instruction appended as the final user message of the summary request.
 *
 * `customInstructions` is reserved for a future `/compact <instructions>`; the caller passes
 * nothing today.
 */
export function buildCompactInstruction(customInstructions?: string): string {
	const customBlock = customInstructions?.trim() ? `\n\nAdditional Instructions:\n${customInstructions}` : "";
	return `${NO_TOOLS_PREAMBLE}${BASE_COMPACT_PROMPT}${customBlock}${NO_TOOLS_TRAILER}`;
}

/**
 * Extract the summary from the model's reply.
 *
 * The `<analysis>` block is a drafting scratchpad: it improves the summary but has no value once
 * the summary is written, so it never enters the context. Falls back to the whole reply when the
 * model ignores the tags.
 */
export function formatSummary(text: string | undefined): string {
	let formatted = text?.trim() ?? "";
	if (!formatted) {
		return "";
	}

	formatted = formatted.replace(/<analysis>[\s\S]*?<\/analysis>/, "");
	const summaryMatch = formatted.match(/<summary>([\s\S]*?)<\/summary>/);
	if (summaryMatch) {
		const summary = summaryMatch[1] ?? "";
		formatted = formatted.replace(/<summary>[\s\S]*?<\/summary>/, `Summary:\n${summary.trim()}`);
	}

	return formatted.replace(/\n\n+/g, "\n\n").trim();
}

/**
 * True when the model answered the summary request with a tool call instead of text.
 *
 * The request carries the session's tools so it can share the cached prefix, which means the model
 * sometimes tries to act on the conversation it was asked to summarize. That attempt has no one to
 * execute it, so the caller treats this attempt as failed and retries.
 */
export function isToolCallReply(message: AgentMessage): boolean {
	return message.role === "assistant" && message.content.some((block) => block.type === "toolCall");
}

export interface SummarizeConversationOptions {
	streamFn: StreamFn;
	model: Model;
	context: Context;
	apiKey: string;
	reserveTokens: number;
	customInstructions?: string;
}

/** Request a summary without adding either attempt to the live transcript. */
export async function summarizeConversation(options: SummarizeConversationOptions): Promise<string> {
	const maxTokens = Math.floor(options.reserveTokens * 0.8);
	if (!Number.isSafeInteger(maxTokens) || maxTokens < 1) {
		throw new Error("Compaction reserveTokens must allow at least one summary token");
	}

	const instruction = buildCompactInstruction(options.customInstructions);
	for (let attempt = 0; attempt < 2; attempt += 1) {
		const retryNote =
			attempt === 0
				? ""
				: "\n\nYour previous attempt called a tool. That call was ignored. Write the summary as text now.";
		const context: Context = {
			...options.context,
			messages: [
				...options.context.messages,
				{
					role: "user",
					content: [{ type: "text", text: instruction + retryNote }],
					timestamp: Date.now(),
				},
			],
		};
		const stream = await options.streamFn(options.model, context, {
			apiKey: options.apiKey,
			maxTokens,
		});
		const reply = await stream.result();
		if (reply.stopReason === "error" || reply.stopReason === "aborted") {
			throw new Error(`Compaction summary failed: ${reply.errorMessage ?? reply.stopReason}`);
		}
		if (isToolCallReply(reply)) {
			continue;
		}
		if (reply.stopReason === "length") {
			throw new Error("Compaction summary reached its output limit");
		}

		const text = reply.content
			.filter((block) => block.type === "text")
			.map((block) => block.text)
			.join("");
		const summary = formatSummary(text);
		if (!summary) {
			throw new Error("Compaction summary was empty");
		}
		return summary;
	}

	throw new Error("Compaction summary called a tool twice");
}

export interface CompactSummaryMessageOptions {
	/** Path to the session jsonl, so the model can read pre-compaction detail back on demand. */
	transcriptPath?: string;
	/** Messages after the cut point were kept verbatim. */
	recentMessagesPreserved?: boolean;
	/** Ask the model to resume without acknowledging the summary. */
	suppressFollowup?: boolean;
}

/** Wrap a summary as the replacement for the compacted history, telling the model to just continue. */
export function buildCompactSummaryMessage(summary: string, options: CompactSummaryMessageOptions = {}): string {
	let message = `This session is continuing after earlier messages were compacted. The summary below covers those earlier messages.

${formatSummary(summary)}`;

	if (options.transcriptPath) {
		message += `\n\nIf you need specific details from before compaction (like exact code snippets, error messages, or content you generated), read the full session file at: ${options.transcriptPath}`;
	}

	if (options.recentMessagesPreserved) {
		message += "\n\nRecent messages are preserved verbatim.";
	}

	if (options.suppressFollowup) {
		message +=
			'\nContinue the conversation from where it left off without asking the user any further questions. Resume directly — do not acknowledge the summary, do not recap what was happening, do not preface with "I\'ll continue" or similar. Pick up the last task as if the break never happened.';
	}

	return message;
}
