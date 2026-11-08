import { syncBuiltinESMExports } from "node:module";
import net from "node:net";

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
