import xterm from "@xterm/headless";

/** Apply cursor movement and incremental repaints before inspecting the visible screen. */
export class TerminalScreen {
	private readonly terminal;
	private pending = 0;
	private rendered = 0;
	constructor(columns: number, rows: number) {
		this.terminal = new xterm.Terminal({ cols: columns, rows, allowProposedApi: true, logLevel: "off", scrollback: 2000 });
	}
	write(data: string): void {
		this.pending++;
		this.terminal.write(data, () => {
			this.pending--;
			if (data.startsWith("\x1b[?2026h")) this.rendered++;
		});
	}
	get idle(): boolean { return this.pending === 0; }
	get paints(): number { return this.rendered; }
	get text(): string {
		const buffer = this.terminal.buffer.active;
		return Array.from({ length: this.terminal.rows }, (_, row) => buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? "").join("\n");
	}
	resize(columns: number, rows: number): void { this.terminal.resize(columns, rows); }
	dispose(): void { this.terminal.dispose(); }
}
