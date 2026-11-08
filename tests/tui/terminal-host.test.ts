import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { createElement } from "react";
import { Text } from "ink";
import { startTerminalHost, type TerminalStreams } from "../../src/cli/ink/terminal-host.ts";
import type { TerminalInputEvent } from "../../src/cli/ink/terminal-input.ts";
import { waitFor } from "../support/fixtures.ts";

class FakeInput extends PassThrough {
	isTTY = true;
	isRaw = false;
	setRawMode(enabled: boolean): this {
		this.isRaw = enabled;
		return this;
	}
}

class FakeOutput extends PassThrough {
	isTTY = true;
	columns = 80;
	rows = 24;
}

test("terminal host owns byte input, renders, and restores terminal state", async () => {
	const stdin = new FakeInput();
	const stdout = new FakeOutput();
	const streams = { stdin, stdout } as unknown as TerminalStreams;
	const events: TerminalInputEvent[] = [];
	let output = "";
	stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });

	const host = startTerminalHost((event) => { events.push(event); }, streams);
	assert.equal(stdin.isRaw, true);
	assert.ok(output.includes("\x1b[?2004h"));
	assert.equal(stdin.listenerCount("data"), 1);

	stdin.write(Buffer.from([0xe4]));
	stdin.write(Buffer.from([0xbd, 0xa0]));
	assert.deepEqual(events, [{ type: "text", text: "你" }]);

	host.rerender(createElement(Text, null, "HOST READY"));
	await waitFor(() => output.includes("HOST READY"), "terminal frame");
	assert.ok(output.includes("HOST READY"));

	host.stop();
	host.stop();
	assert.equal(stdin.isRaw, false);
	assert.ok(output.includes("\x1b[?2004l"));
	assert.equal(stdin.listenerCount("data"), 0);
	stdin.write(Buffer.from("x"));
	assert.equal(events.length, 1);

	stdin.isRaw = true;
	const secondHost = startTerminalHost(() => {}, streams);
	secondHost.stop();
	assert.equal(stdin.isRaw, true);
});

test("terminal host requires an interactive TTY", () => {
	const stdin = new FakeInput();
	const stdout = new FakeOutput();
	stdin.isTTY = false;
	assert.throws(
		() => startTerminalHost(() => {}, { stdin, stdout } as unknown as TerminalStreams),
		/requires an interactive TTY/,
	);
});
