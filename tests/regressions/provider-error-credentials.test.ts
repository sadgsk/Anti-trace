import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { appendEntry, createSessionFile } from "../../src/harness/session.ts";
import { streamModel } from "../../src/llm/adapter.ts";
import { tempWorkspace } from "../support/fixtures.ts";
import { testModel } from "../support/harness.ts";
import { createHttpFixture } from "../support/http-server.ts";

for (const api of ["openai-completions", "openai-responses", "anthropic-messages"] as const) {
	for (const mode of ["HTTP error", "SSE error"] as const) {
		test(`${api}: ${mode} cannot expose the request key in diagnostics or session JSONL`, async (t) => {
			const secret = "synthetic-regression-key";
			const http = await createHttpFixture(t, (_request, response) => {
				if (mode === "HTTP error") response.writeHead(401).end(`${secret} denied; repeated ${secret}`);
				else response.writeHead(200, { "content-type": "text/event-stream" })
					.end(`event: error\ndata: ${JSON.stringify({ type: "error", error: { message: `${secret} denied` } })}\n\n`);
			});
			const stream = await streamModel({ ...testModel, api, baseUrl: http.url }, { messages: [] }, { apiKey: secret });
			const message = await stream.result();
			assert.equal(message.stopReason, "error");
			assert.doesNotMatch(message.errorMessage ?? "", /synthetic-regression-key/);
			assert.match(message.errorMessage ?? "", /redacted/);
			const root = tempWorkspace(t), session = createSessionFile(root, join(root, "sessions"));
			appendEntry(session, { type: "message", message });
			assert.doesNotMatch(readFileSync(session.path, "utf8"), /synthetic-regression-key/);
		});
	}
}
