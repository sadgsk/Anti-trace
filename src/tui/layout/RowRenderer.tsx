import { PassThrough, Writable } from "node:stream";
import { type ReactNode } from "react";
import { Box, render } from "ink";
import { ThemeSnapshotProvider } from "../theme/ThemeProvider.tsx";
import type { TerminalTheme } from "../theme/theme.ts";
import { LocaleProvider } from "../locale/LocaleProvider.tsx";
import type { UiLanguage } from "../../cli/locale.ts";
import { LayoutOnlyContext } from "./layout-only.ts";

/** A reusable, memory-only layout root. It never owns the terminal or runs animations.
 * Call outside React render/commit (the viewport's scheduled preparation or the output writer).
 */
export class RowRenderer {
	private frame = "";
	private columns = 80;
	private readonly input = new PassThrough();
	private readonly output = Object.defineProperties(new Writable({ write: (chunk, _encoding, done) => {
		const text = chunk.toString();
		if (!/^\x1b\[\?25[hl]$/.test(text)) this.frame = text;
		done();
	} }), { columns: { get: () => this.columns }, rows: { value: 24 }, isTTY: { value: false } });
	private instance?: ReturnType<typeof render>;
	rows(node: ReactNode, columns: number, theme: TerminalTheme, language: UiLanguage): string[] {
		this.columns = columns; this.frame = "";
		const locale = { subscribe: () => () => {}, getSnapshot: () => language };
		const tree = <LayoutOnlyContext.Provider value={true}><ThemeSnapshotProvider value={theme}><LocaleProvider locale={locale}>
			<Box width={columns} flexDirection="column" flexShrink={0}>{node}</Box>
		</LocaleProvider></ThemeSnapshotProvider></LayoutOnlyContext.Provider>;
		if (this.instance) this.instance.rerender(tree);
		else this.instance = render(tree, { stdin: this.input as unknown as NodeJS.ReadStream, stdout: this.output as NodeJS.WriteStream,
			stderr: this.output as NodeJS.WriteStream, debug: true, patchConsole: false, exitOnCtrlC: false });
		return this.frame ? this.frame.replace(/\n$/, "").split("\n") : [];
	}
	dispose(): void {
		this.instance?.unmount(); this.instance?.cleanup(); this.instance = undefined;
		this.input.destroy(); this.output.destroy();
	}
}
