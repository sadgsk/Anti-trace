import assert from "node:assert/strict";
import test from "node:test";
import { PassThrough } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { Harness } from "../../src/harness/harness.ts";
import { startTerminalRepl } from "../../src/cli/repl/terminal-repl.tsx";
import { createFakeStreamFn } from "../support/fake-stream.ts";
import { waitFor } from "../support/fixtures.ts";
import { mouseWheelDirection } from "../../src/cli/ink/mouse-wheel.ts";
import type { TerminalStreams } from "../../src/cli/ink/terminal-host.ts";
import type { ViewportMetrics } from "../../src/tui/viewport-state.ts";
class Input extends PassThrough { isTTY = true; isRaw = false; setRawMode(value: boolean) { this.isRaw = value; return this; } }
class Output extends PassThrough { isTTY = true; columns = 100; rows = 30; }
const strip = (text: string) => text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
function fixture() {
	const root = resolve(mkdtempSync(join(tmpdir(),"expand-history-"))), stdin = new Input(), stdout = new Output();
	let output = "", frame = "", paints = 0;
	stdout.on("data", chunk => {
		const write = chunk.toString(); output += write;
		if (write.startsWith("\x1b[?2026h")) { frame = strip(write); paints++; }
	});
	const command = (prefix:string) => `"${process.execPath}" -e "for(let i=0;i<30;i++)console.log('${prefix}_'+String(i).padStart(2,'0'))"`;
	const h = new Harness({ cwd:root, sessionsRoot:join(root,"sessions"), apiKey:"fake", model:{ id:"local",name:"local",provider:"test",api:"openai-completions",baseUrl:"http://127.0.0.1:1",contextWindow:100000 },
		streamFn:createFakeStreamFn([{toolCalls:[{id:"older",name:"bash",arguments:{command:command("OLDER")}},{id:"newer",name:"bash",arguments:{command:command("NEWER")}}]}, {text:Array.from({length:80},(_,i)=>`REPLY_${String(i).padStart(2,"0")}`).join("\n")}]) });
	const app = startTerminalRepl({harness:h,cwd:root,permissionMode:"yolo",streams:{stdin,stdout} as unknown as TerminalStreams});
	let metrics: ViewportMetrics | undefined;
	const setMetrics = app.repl.setViewportMetrics;
	app.repl.setViewportMetrics = value => { metrics = value; setMetrics(value); };
	return {root,stdin,stdout,app,output:()=>output,frame:()=>frame,paints:()=>paints,metrics:()=>metrics,
		close(){app.stop();stdin.destroy();stdout.destroy();assert.equal(dirname(root),resolve(tmpdir()));assert.match(basename(root),/^expand-history-/);rmSync(root,{recursive:true,force:true});}};
}
async function finishPrompt(f: ReturnType<typeof fixture>) {
	f.stdin.write("run\r");
	await waitFor(() => !f.app.repl.getSnapshot().busy && f.frame().includes("REPLY_79"), "completed prompt painted in the real terminal");
}
test("Ctrl+O immediately shows expanded tool content instead of the final reply at the bottom",async()=>{
	const f=fixture();
	try{await finishPrompt(f);
		f.stdin.write("\x0f");
		await waitFor(() => f.frame().includes("NEWER_06"), "expanded tool painted without another keypress");
		const state=f.app.repl.getSnapshot();assert.equal(state.expanded,true);assert.equal(state.viewingHistory,true);assert.ok(state.scrollOffset>0);
		assert.match(f.frame(),/NEWER_06/);assert.doesNotMatch(f.frame(),/REPLY_79/);
		f.stdin.write("\x1b[1;5F");
		await waitFor(() => !f.app.repl.getSnapshot().viewingHistory && f.frame().includes("REPLY_79"), "return to latest reply painted");
		assert.equal(f.app.repl.getSnapshot().viewingHistory,false);assert.equal(f.app.repl.getSnapshot().scrollOffset,0);
	}finally{f.close();}
});
test("wheel review and Ctrl+O retain the older tool, with collapse and resize preserving its anchor",async()=>{
	const f=fixture();
	try{await finishPrompt(f);
		const older=f.app.repl.getSnapshot().transcript.find(item=>item.kind==="tool")!;
		const beforeTop = f.paints();
		f.stdin.write("\x1b[<64;5;5M".repeat(100));
		await waitFor(() => f.paints() > beforeTop && f.metrics()?.offset === f.metrics()?.limit, "top of history painted");
		// Navigate to the actual message anchor, rather than assuming the welcome header has a fixed height.
		for (let i = 0; i < 30 && f.metrics()?.anchor?.id !== older.id; i++) {
			const previous = f.metrics()!.offset, before = f.paints();
			f.stdin.write("\x1b[<65;5;5M");
			await waitFor(() => f.paints() > before && f.metrics()!.offset < previous, "wheel movement painted");
		}
		assert.equal(f.metrics()?.anchor?.id, older.id);
		assert.equal(f.app.repl.getSnapshot().viewingHistory,true);f.stdin.write("\x0f");
		await waitFor(() => f.frame().includes("OLDER_06"), "older expanded tool painted");
		assert.equal(f.app.repl.getSnapshot().reviewAnchor?.id,older.id);assert.match(f.frame(),/OLDER_06/);
		f.stdin.write("\x0f");
		await waitFor(() => f.frame().includes("OLDER_00") && !f.frame().includes("OLDER_06"), "collapsed older tool painted");
		assert.equal(f.app.repl.getSnapshot().reviewAnchor?.id,older.id);assert.match(f.frame(),/OLDER_00/);assert.doesNotMatch(f.frame(),/OLDER_06/);
		const beforeResize = f.paints(); f.stdout.columns=75;f.stdout.emit("resize");
		await waitFor(() => f.paints() > beforeResize, "resized reading view painted");
		f.stdin.write("\x0f");
		await waitFor(() => f.frame().includes("OLDER_06"), "older tool expanded after resize");
		assert.equal(f.app.repl.getSnapshot().reviewAnchor?.id,older.id);
		assert.equal(f.app.prompt.getDraft().text,"");
	}finally{f.close();}
});
test("mouse mode is cleaned up and wheel decoding ignores clicks, releases and horizontal scrolling",()=>{
	assert.equal(mouseWheelDirection("\x1b[<64;2;3M"),1);assert.equal(mouseWheelDirection("\x1b[<65;2;3M"),-1);
	for(const raw of ["\x1b[<0;2;3M","\x1b[<64;2;3m","\x1b[<66;2;3M"])assert.equal(mouseWheelDirection(raw),0);
	const f=fixture();f.close();assert.match(f.output(),/\x1b\[\?1000h/);assert.match(f.output(),/\x1b\[\?1000l/);assert.match(f.output(),/\x1b\[\?1006l/);
});
