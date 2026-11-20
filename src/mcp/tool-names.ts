import { digest } from "./util.ts";

export function mcpToolName(serverId: string, tool: string): string {
	const plain = `mcp__${serverId}__${tool}`;
	if (plain.length <= 64 && /^[A-Za-z0-9_-]+$/.test(plain) && !serverId.includes("__") && !tool.includes("__")
		&& !serverId.endsWith("_") && !tool.startsWith("_")) return plain;
	const suffix = digest([serverId, tool]).slice(0, 16);
	return plain.replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, 64 - suffix.length - 1) + "_" + suffix;
}
