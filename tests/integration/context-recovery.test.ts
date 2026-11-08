import assert from "node:assert/strict";
import test from "node:test";
import { loadSession } from "../../src/harness/session.ts";
import { createTestHarness, messageText } from "../support/harness.ts";
import type { ResponseStep } from "../support/scripted-model.ts";

for (const scenario of ["threshold", "overflow-error", "overflow-length", "summary-failure", "summary-tool-retry"] as const) {
	test(`automatic compaction: ${scenario} preserves the live and persisted conversation`, async (t) => {
		const steps: ResponseStep[] = [{ text: "old answer" }, { text: "recent answer" }];
		steps.push(scenario === "overflow-error" || scenario === "summary-failure" ? { error: "Your input exceeds the context window" }
			: scenario === "overflow-length" ? { stopReason: "length", usage: { input: 30000, output: 0 } } : { text: "accepted" });
		if (scenario === "summary-tool-retry") steps.push({ toolCalls: [{ id: "ignored", name: "read", arguments: { path: "missing" } }] });
		steps.push(scenario === "summary-failure" ? { error: "summary provider failed" } : { text: "<analysis>draft</analysis><summary>short</summary>" });
		if (scenario === "overflow-error" || scenario === "overflow-length") steps.push({ text: "recovered", usage: { input: 12000, output: 5 } });
		const { harness, agent, scripted } = createTestHarness(t, steps);
		await harness.prompt("old");
		await harness.prompt("r".repeat(82000));
		harness.setContextWindow(30000);
		if (scenario === "summary-failure") await assert.rejects(harness.prompt("current"), /summary provider failed/);
		else {
			await harness.prompt("current");
			assert.match(messageText(agent.state.messages[0]), /Summary:\nshort/);
			assert.equal(messageText(agent.state.messages.at(-1)), scenario.startsWith("overflow") ? "recovered" : "accepted");
		}
		const loaded = loadSession(harness.listSessions()[0]!.filePath);
		assert.deepEqual(loaded.messages, agent.state.messages);
		assert.equal(agent.state.messages.filter((message) => message.role === "user" && messageText(message) === "current").length, 1);
		assert.equal(loaded.entries.filter((entry) => entry.type === "compaction").length, scenario === "summary-failure" ? 0 : 1);
		assert.equal(scripted.pendingResponses, 0);
	});
}
