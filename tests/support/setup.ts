import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import { afterEach, beforeEach } from "node:test";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

// Shared user defaults must not leak between tests. The runner owns and removes this entire root.
const previousHomes: Array<string | undefined> = [];
beforeEach(() => {
	const root = process.env.CLI_AGENT_TEST_ROOT;
	if (!root) throw new Error("Storage tests require the isolated test runner");
	previousHomes.push(process.env.ANTI_TRACE_HOME);
	process.env.ANTI_TRACE_HOME = join(root, "storage", randomUUID());
});
afterEach(() => {
	const previous = previousHomes.pop();
	if (previous === undefined) delete process.env.ANTI_TRACE_HOME;
	else process.env.ANTI_TRACE_HOME = previous;
});

// Node's HTTP clients and fetch/undici eventually connect through a net.Socket.
// Keep actual loopback HTTP available while failing accidental external requests.
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (this: net.Socket, ...args: Parameters<typeof connect>) {
	let options: unknown = args[0];
	if (Array.isArray(options)) options = options[0];
	if (options && typeof options === "object") {
		const address = options as { host?: string; hostname?: string; path?: string };
		const host = address.host ?? address.hostname ?? "localhost";
		if (!address.path && !["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) {
			throw new Error(`Offline tests cannot connect to ${host}; use a loopback fixture or a fake streamFn.`);
		}
	} else if (typeof options === "number" && typeof args[1] === "string") {
		if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(args[1])) {
			throw new Error(`Offline tests cannot connect to ${args[1]}`);
		}
	}
	return Reflect.apply(connect, this, args);
} as typeof connect;
syncBuiltinESMExports();
