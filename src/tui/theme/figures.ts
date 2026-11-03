import stringWidth from "string-width";
export const figures = {
	pointer: "❯", success: "√", error: "✖", warning: "⚠︎", info: "ⓘ", pending: "○", loading: "…",
	tool: process.platform === "darwin" ? "⏺" : "●", branch: "⎿", thinking: "∴", compact: "✻",
} as const;
export const supportsBlockGrid = () => stringWidth("█") === 1 && stringWidth(" ") === 1;
