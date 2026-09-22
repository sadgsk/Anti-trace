import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { getOpenAIConfig } from "../env.ts";
import { Harness } from "../harness/harness.ts";
import { streamOpenAIChat } from "../llm/openai-chat.ts";
import type { ImageContent, Model } from "../types.ts";
import { isImagePasteKey, readClipboardImage, type PasteKey } from "./utils/image.ts";
import { renderEvent } from "./render.ts";

const cwd = process.cwd();
const { apiKey, baseUrl, modelId } = getOpenAIConfig();
const model: Model = {
	id: modelId,
	name: modelId,
	provider: "openai",
	baseUrl,
	api: "openai-completions",
};

const harness = new Harness({
	cwd,
	apiKey,
	model,
	streamFn: streamOpenAIChat,
});
harness.subscribe(renderEvent);

const rl = createInterface({ input: stdin, output: stdout });
const pendingImages: ImageContent[] = [];
let exiting = false;
const pasteKeyLabel = process.platform === "win32" ? "Alt+V" : "Ctrl+V";

function attachClipboardImage(): void {
	const image = readClipboardImage();
	if (!image) {
		console.log("\n剪贴板里没有图片");
		return;
	}
	pendingImages.push(image);
	if (rl.line.endsWith("v")) {
		rl.write(null, { name: "backspace" });
	}
	console.log(`\n[Image #${pendingImages.length}]`);
}

stdin.on("keypress", (_str: string, key: PasteKey) => {
	if (exiting || !isImagePasteKey(key)) {
		return;
	}
	attachClipboardImage();
});

function shutdown(): void {
	exiting = true;
	rl.close();
	process.exit(0);
}

process.on("SIGINT", () => {
	if (harness.agent.state.isStreaming) {
		harness.abort();
		return;
	}
	shutdown();
});

console.log(`model=${modelId}`);
console.log(`cwd=${cwd}`);
console.log(`commands: /new  /resume  /exit  paste image: ${pasteKeyLabel}`);

function formatLastOpenedAt(ms: number): string {
	const date = new Date(ms);
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

while (!exiting) {
	let line: string;
	try {
		line = (await rl.question("you> ")).trim();
	} catch {
		break;
	}
	if (exiting) {
		break;
	}
	if (line.length === 0 && pendingImages.length === 0) {
		continue;
	}
	if (line === "/exit") {
		shutdown();
		break;
	}
	if (line === "/new") {
		try {
			harness.newSession();
			console.log("new");
		} catch (error) {
			console.error(error instanceof Error ? error.message : error);
		}
		continue;
	}
	if (line === "/resume") {
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
			choice = (await rl.question("resume> ")).trim();
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
	const images = pendingImages.splice(0, pendingImages.length);
	try {
		await harness.prompt(line, images.length > 0 ? images : undefined);
	} catch (error) {
		console.error(error instanceof Error ? error.message : error);
	}
}
