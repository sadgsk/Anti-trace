import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import net from "node:net";
import { homedir } from "node:os";
import { isAbsolute, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("default tests use an isolated home and working directory without BYOK settings", () => {
	const root = process.env.CLI_AGENT_TEST_ROOT;
	assert.ok(root);
	for (const path of [homedir(), process.cwd()]) {
		const child = relative(root, path);
		assert.ok(child && !child.startsWith("..") && !isAbsolute(child));
	}
	assert.equal(process.env.CLI_AGENT_CONFIG, undefined);
	assert.equal(process.env.NODE_OPTIONS, undefined);
	assert.equal(process.env.OPENAI_API_KEY, undefined);
	assert.equal(process.env.ANTHROPIC_API_KEY, undefined);
});

test("raw sockets and fetch cannot reach external endpoints", async () => {
	const socket = new net.Socket();
	try { assert.throws(() => socket.connect({ host: "example.invalid", port: 443 }), /Offline tests cannot connect/); }
	finally { socket.destroy(); }
	await assert.rejects(fetch("https://example.invalid/test"), (error: unknown) => {
		assert.ok(error instanceof Error && error.cause instanceof Error);
		assert.match(error.cause.message, /Offline tests cannot connect/);
		return true;
	});
});

test("an unmatched test filter fails instead of silently passing an empty suite", () => {
	const result = spawnSync(process.execPath, [fileURLToPath(new URL("../../scripts/run-tests.mjs", import.meta.url)), "no-such-test-7c11d"], {
		encoding: "utf8", timeout: 10000, windowsHide: true,
	});
	assert.equal(result.status, 1);
	assert.match(result.stderr, /No tests matched/);
});
