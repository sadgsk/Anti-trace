export interface SseEvent { event?: string; data: string }

/** Decode SSE framing independently of HTTP chunks, UTF-8 boundaries and line endings. */
export async function* readSse(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<SseEvent> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let data: string[] = [];
	let event: string | undefined;
	let eof = false;
	const onAbort = () => { void reader.cancel(signal?.reason).catch(() => {}); };
	signal?.addEventListener("abort", onAbort, { once: true });
	const consumeLine = (line: string): SseEvent | undefined => {
		if (!line) {
			const result = data.length ? { event, data: data.join("\n") } : undefined;
			data = [];
			event = undefined;
			return result;
		}
		if (line.startsWith(":")) return;
		const colon = line.indexOf(":");
		const field = colon < 0 ? line : line.slice(0, colon);
		const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
		if (field === "data") data.push(value);
		else if (field === "event") event = value;
	};
	try {
		while (!eof) {
			signal?.throwIfAborted();
			const result = await reader.read();
			signal?.throwIfAborted();
			eof = result.done;
			buffer += eof ? decoder.decode() : decoder.decode(result.value, { stream: true });
			let offset = 0;
			for (let i = 0; i < buffer.length; i++) {
				const char = buffer[i];
				if (char !== "\r" && char !== "\n") continue;
				if (char === "\r" && i === buffer.length - 1 && !eof) break;
				const parsed = consumeLine(buffer.slice(offset, i));
				if (char === "\r" && buffer[i + 1] === "\n") i++;
				offset = i + 1;
				if (parsed) yield parsed;
			}
			buffer = buffer.slice(offset);
		}
		if (buffer) {
			const parsed = consumeLine(buffer);
			if (parsed) yield parsed;
		}
		const parsed = consumeLine("");
		if (parsed) yield parsed;
	} finally {
		signal?.removeEventListener("abort", onAbort);
		if (!eof) await reader.cancel().catch(() => {});
		reader.releaseLock();
	}
}
