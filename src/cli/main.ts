import { getOpenAIConfig } from "../env.ts";
import { Harness } from "../harness/harness.ts";
import { streamOpenAIChat } from "../llm/openai-chat.ts";
import type { ImageContent, Model } from "../types.ts";
import { readClipboardImage } from "./utils/image.ts";
import { renderEvent } from "./render.ts";
import { CliPrompt } from "./input/cli-prompt.ts";

const cwd = process.cwd();
const { apiKey, baseUrl, modelId, contextWindow } = getOpenAIConfig();
const model: Model = {
	id: modelId,
	name: modelId,
	provider: "openai",
	baseUrl,
	api: "openai-completions",
	contextWindow,
};

const harness = new Harness({
	cwd,
	apiKey,
	model,
	streamFn: streamOpenAIChat,
});
harness.subscribe(renderEvent);

const pendingImages: ImageContent[] = [];
let exiting = false;
const pasteKeyLabel = process.platform === "win32" ? "Alt+V" : "Ctrl+V";

function attachClipboardImage(): string {
	const image = readClipboardImage();
	if (!image) {
		return "剪贴板里没有图片";
	}
	pendingImages.push(image);
	return `[Image #${pendingImages.length}]`;
}

const prompt = new CliPrompt({ onImagePaste: attachClipboardImage });

function shutdown(): void {
	exiting = true;
	prompt.dispose();
	process.exit(0);
}

process.once("exit", () => prompt.dispose());
process.once("SIGTERM", () => {
	prompt.dispose();
	process.exit(143);
});
process.once("SIGHUP", () => {
	prompt.dispose();
	process.exit(129);
});

process.on("SIGINT", () => {
	if (harness.agent.state.isStreaming) {
		harness.abort();
		return;
	}
	shutdown();
});

console.log(`model=${modelId}`);
console.log(`cwd=${cwd}`);
console.log(`ctx 0/${contextWindow}`);
console.log(`commands: /new  /resume  /context  /compact  /paste  /exit  paste image: ${pasteKeyLabel}`);
console.log("multiline: Ctrl+J or Shift+Enter; /paste then Ctrl+D for terminals without paste detection");

function formatLastOpenedAt(ms: number): string {
	const date = new Date(ms);
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

while (!exiting) {
	let line: string;
	try {
		const result = await prompt.read("you> ", { allowPasteMode: true });
		if (result.type === "interrupt") {
			shutdown();
			break;
		}
		if (result.type === "end") {
			break;
		}
		line = result.text;
	} catch {
		break;
	}
	if (exiting) {
		break;
	}
	if (line.trim().length === 0 && pendingImages.length === 0) {
		continue;
	}
	const command = line.includes("\n") ? null : line.trim();
	if (command === "/exit") {
		shutdown();
		break;
	}
	if (command === "/new") {
		try {
			harness.newSession();
			console.log("new");
		} catch (error) {
			console.error(error instanceof Error ? error.message : error);
		}
		continue;
	}
	if (command === "/resume") {
		const items = harness.listSessions();
		if (items.length === 0) {
			console.log("没有可恢复的会话");
			continue;
		}
		for (let i = 0; i < items.length; i++) {
			const item = items[i];
			console.log(`${i + 1}. ${item.name}  ${formatLastOpenedAt(item.lastOpenedAt)}`);
		}
		let choice: string;
		try {
			const result = await prompt.read("resume> ");
			if (result.type === "interrupt") {
				shutdown();
				break;
			}
			if (result.type === "end") {
				break;
			}
			choice = result.text.trim();
		} catch {
			break;
		}
		if (choice.length === 0) {
			continue;
		}
		const index = Number.parseInt(choice, 10);
		if (!harness.resumeAt(index)) {
			console.log("没有这一条");
		}
		continue;
	}
	if (command === "/context") {
		const { used, window: currentWindow } = harness.contextUsage();
		console.log(`ctx ${used}/${currentWindow}`);
		continue;
	}
	if (command?.startsWith("/context ")) {
		const argument = command.slice("/context ".length).trim();
		if (!/^\d+$/.test(argument) || Number(argument) <= 0) {
			console.log("用法：/context <正整数>");
			continue;
		}
		try {
			harness.setContextWindow(Number(argument));
			const { used, window: currentWindow } = harness.contextUsage();
			console.log(`ctx ${used}/${currentWindow}`);
		} catch (error) {
			console.error(error instanceof Error ? error.message : error);
		}
		continue;
	}
	if (command === "/compact") {
		try {
			const result = await harness.manualCompact();
			if (result === "below-threshold") {
				console.log("上下文使用未超过窗口的 1/4，无需压缩");
			} else if (result === "nothing-to-compact") {
				console.log("没有可压缩的旧历史，或压缩后还没有新消息");
			} else {
				const { used, window: currentWindow } = harness.contextUsage();
				console.log(`已压缩，ctx ${used}/${currentWindow}`);
			}
		} catch (error) {
			console.error(error instanceof Error ? error.message : error);
		}
		continue;
	}
	const images = pendingImages.splice(0, pendingImages.length);
	try {
		await harness.prompt(line, images.length > 0 ? images : undefined);
		const { used, window: currentWindow } = harness.contextUsage();
		console.log(`ctx ${used}/${currentWindow}`);
	} catch (error) {
		console.error(error instanceof Error ? error.message : error);
	}
}
