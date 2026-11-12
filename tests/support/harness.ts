import { join } from "node:path";
import type { TestContext } from "node:test";
import { Harness, type HarnessEvent } from "../../src/harness/harness.ts";
import type { AgentMessage, AgentTool, Model } from "../../src/types.ts";
import { tempWorkspace } from "./fixtures.ts";
import { createScriptedModel, type ResponseStep } from "./scripted-model.ts";

export const testModel: Model = {
	id: "test-model", name: "Scripted model", provider: "test",
	api: "openai-completions", baseUrl: "http://127.0.0.1:1/v1", contextWindow: 128000,
};

export function messageText(message: AgentMessage | undefined): string {
	return message?.content.filter((block) => block.type === "text").map((block) => block.text).join("") ?? "";
}

export function createTestHarness(t: TestContext, steps: readonly ResponseStep[] = [], options: {
	model?: Model; unconfigured?: boolean; tools?: AgentTool[];
	appHome?: string; profileId?: string;
} = {}) {
	const root = tempWorkspace(t, async () => {
		harness.abort();
		await harness.agent.waitForIdle();
		unsubscribe();
	});
	const scripted = createScriptedModel(steps);
	const sessionsRoot = join(root, "sessions");
	const harness = new Harness({
		cwd: root, sessionsRoot, streamFn: scripted.streamFn, appHome: options.appHome, profileId: options.profileId,
		...(options.unconfigured ? {} : { model: structuredClone(options.model ?? testModel), apiKey: "test-only-key" }),
	});
	if (options.tools) harness.agent.state.tools = options.tools;
	const events: HarnessEvent[] = [];
	const unsubscribe = harness.subscribe((event) => { events.push(structuredClone(event)); });
	return { root, sessionsRoot, harness, agent: harness.agent, events, scripted };
}
