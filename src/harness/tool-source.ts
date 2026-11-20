import type { AgentTool, Model } from "../types.ts";
import type { McpBinding } from "../mcp/types.ts";

export interface ToolSourceContext {
	binding: McpBinding;
	model: Model;
	outputDirectory: string;
	reservedNames: ReadonlySet<string>;
}

export interface AcquiredToolSource {
	tools: readonly AgentTool[];
	instructions: readonly string[];
	diagnostics: readonly string[];
	release(): void | Promise<void>;
}

export interface ToolSource {
	acquire(context: ToolSourceContext, signal: AbortSignal): AcquiredToolSource | Promise<AcquiredToolSource>;
}
