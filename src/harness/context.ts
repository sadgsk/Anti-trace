import type { AgentMessage, ImageContent, TextContent } from "../types.ts";

const ESTIMATED_IMAGE_CHARS = 4800;

/** Estimate token count for a whole transcript, message by message. */
export function estimateMessagesTokens(messages: readonly AgentMessage[]): number {
	let total = 0;
	for (const message of messages) {
		total += estimateTokens(message);
	}
	return total;
}

/** Estimate token count for one message using a character heuristic. */
export function estimateTokens(message: AgentMessage): number {
	const textAndImageChars = (content: ReadonlyArray<TextContent | ImageContent>): number => {
		let chars = 0;
		for (const block of content) {
			if (block.type === "text") {
				chars += block.text.length;
			} else if (block.type === "image") {
				chars += ESTIMATED_IMAGE_CHARS;
			}
		}
		return chars;
	};

	switch (message.role) {
		case "user":
		case "toolResult":
			return Math.ceil(textAndImageChars(message.content) / 4);
		case "assistant": {
			let chars = 0;
			for (const block of message.content) {
				if (block.type === "text") {
					chars += block.text.length;
				} else if (block.type === "thinking") {
					chars += block.thinking.length;
				} else if (block.type === "toolCall") {
					let args = "";
					try {
						args = JSON.stringify(block.arguments) ?? "";
					} catch {
						args = "";
					}
					chars += block.name.length + args.length;
				}
			}
			return Math.ceil(chars / 4);
		}
	}
}
