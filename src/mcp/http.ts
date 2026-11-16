import { McpError } from "./types.ts";
import { deadline, MCP_LIMITS } from "./util.ts";

/** Bound JSON bodies and individual SSE events before the SDK parses them. */
export function boundedFetch(lifetime: AbortSignal, fetchImpl: typeof fetch = fetch, timeoutMs = 60000): typeof fetch {
	return async (input, init) => {
		const budget = deadline(timeoutMs);
		const signal = AbortSignal.any([lifetime, budget.signal, ...(init?.signal ? [init.signal] : []), ...(input instanceof Request ? [input.signal] : [])]);
		let response: Response;
		try { response = await fetchImpl(input, { ...init, signal }); } catch (error) { budget.dispose(); throw error; }
		if (!response.body) { budget.dispose(); return response; }
		const sse = response.headers.get("content-type")?.split(";")[0].trim() === "text/event-stream";
		// A notification subscription is long-lived; its caller/lifetime signal owns cancellation.
		if (sse) budget.dispose();
		const reader = response.body.getReader();
		let bytes = 0, lineBytes = 0, lastCR = false;
		const body = new ReadableStream<Uint8Array>({
			async pull(controller) {
				try {
					const { done, value } = await reader.read();
					if (done) { budget.dispose(); controller.close(); return; }
					if (sse) {
						for (const byte of value) {
							// CR, LF and CRLF are all SSE line endings. A blank line ends an event.
							if (byte === 10 && lastCR) { lastCR = false; continue; }
							lastCR = byte === 13;
							if (byte === 10 || byte === 13) { if (!lineBytes) bytes = 0; lineBytes = 0; }
							else { bytes++; lineBytes++; }
							if (bytes > MCP_LIMITS.messageBytes) throw new McpError("limit", "MCP SSE 事件超过接收上限。");
						}
					} else if ((bytes += value.byteLength) > MCP_LIMITS.messageBytes) throw new McpError("limit", "MCP HTTP 响应超过接收上限。");
					controller.enqueue(value);
				} catch (error) { budget.dispose(); controller.error(error); await reader.cancel().catch(() => {}); }
			},
			cancel(reason) { budget.dispose(); return reader.cancel(reason); },
		});
		const bounded = new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
		Object.defineProperty(bounded, "url", { value: response.url });
		return bounded;
	};
}
