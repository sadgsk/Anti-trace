import assert from "node:assert/strict";
import { createServer, type ServerResponse, type IncomingHttpHeaders } from "node:http";
import type { TestContext } from "node:test";

export interface HttpRequest { path: string; headers: IncomingHttpHeaders; body: unknown }

export async function createHttpFixture(t: TestContext,
	respond: (request: HttpRequest, response: ServerResponse, index: number) => void | Promise<void>,
) {
	const requests: HttpRequest[] = [];
	const errors: unknown[] = [];
	const server = createServer(async (request, response) => {
		try {
			const chunks: Buffer[] = [];
			for await (const chunk of request) chunks.push(Buffer.from(chunk));
			const text = Buffer.concat(chunks).toString("utf8");
			const captured = { path: request.url ?? "/", headers: request.headers, body: text ? JSON.parse(text) as unknown : undefined };
			requests.push(captured);
			await respond(captured, response, requests.length - 1);
		} catch (error) {
			errors.push(error);
			response.writeHead(500).end("Test fixture error");
		}
	});
	t.after(async () => {
		server.closeAllConnections();
		await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
		assert.deepEqual(errors, [], "HTTP fixture must not swallow handler failures");
	});
	await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
	const address = server.address();
	assert.ok(address && typeof address === "object");
	return { url: `http://127.0.0.1:${address.port}/v1`, requests };
}

export function chatResponse(text: string): string {
	return `data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`;
}
