import assert from "node:assert/strict";
import test from "node:test";
import { PassThrough, Writable } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createElement } from "react";
import { render } from "ink";
import { Harness } from "../../src/harness/harness.ts";
import { startTerminalRepl } from "../../src/cli/repl/terminal-repl.tsx";
import { ReplScreen } from "../../src/tui/layout/ReplScreen.tsx";
import { createFakeStreamFn } from "../support/fake-stream.ts";
import { mouseWheelDirection } from "../../src/cli/ink/mouse-wheel.ts";
import type { TerminalStreams } from "../../src/cli/ink/terminal-host.ts";
class Input extends PassThrough { isTTY = true; isRaw = false; setRawMode(value: boolean) { this.isRaw = value; return this; } }
class Output extends PassThrough { isTTY = true; columns = 100; rows = 30; }
const pause = (ms=80) => new Promise(resolve => setTimeout(resolve,ms));
async function until(check:()=>boolean) { for(let i=0;i<150&&!check();i++) await pause(10); assert.ok(check(),"timed out"); }
function fixture() {
	const root = resolve(mkdtempSync(join(tmpdir(),"expand-history-"))), stdin = new Input(), stdout = new Output(); let output="";
	stdout.on("data",chunk=>{output+=chunk.toString();});
	const command = (prefix:string) => `"${process.execPath}" -e "for(let i=0;i<30;i++)console.log('${prefix}_'+String(i).padStart(2,'0'))"`;
	const h = new Harness({ cwd:root, sessionsRoot:join(root,"sessions"), apiKey:"fake", model:{ id:"local",name:"local",provider:"test",api:"openai-completions",baseUrl:"http://127.0.0.1:1",contextWindow:100000 },
		streamFn:createFakeStreamFn([{toolCalls:[{id:"older",name:"bash",arguments:{command:command("OLDER")}},{id:"newer",name:"bash",arguments:{command:command("NEWER")}}]}, {text:Array.from({length:80},(_,i)=>`REPLY_${String(i).padStart(2,"0")}`).join("\n")}]) });
	const app = startTerminalRepl({harness:h,cwd:root,permissionMode:"yolo",streams:{stdin,stdout} as unknown as TerminalStreams});
	return {root,stdin,stdout,app,output:()=>output,close(){app.stop();stdin.destroy();stdout.destroy();assert.equal(dirname(root),resolve(tmpdir()));assert.match(basename(root),/^expand-history-/);rmSync(root,{recursive:true,force:true});}};
}
async function snapshot(f:ReturnType<typeof fixture>) {
	const frames:string[]=[],stdin=new PassThrough(),stdout=new Writable({write(chunk,_enc,done){frames.push(chunk.toString());done();}});
	Object.assign(stdout,{columns:99,rows:30,isTTY:false});
	const app=render(createElement(ReplScreen,{repl:f.app.repl,prompt:f.app.prompt,suggestions:f.app.suggestions,cwd:f.root,columns:99,rows:30}),{stdin:stdin as any,stdout:stdout as any,debug:true,patchConsole:false,exitOnCtrlC:false});
	try{await pause();return (frames.at(-1)??"").replace(/\x1b\[[0-9;]*m/g,"");}finally{app.unmount();app.cleanup();stdin.destroy();stdout.destroy();}
}
test("Ctrl+O immediately shows expanded tool content instead of the final reply at the bottom",async()=>{
	const f=fixture();
	try{f.stdin.write("run\r");await until(()=>!f.app.repl.getSnapshot().busy&&f.app.repl.getSnapshot().transcript.some(item=>item.kind==="tool"));await pause();
		f.stdin.write("\x0f");await pause();const state=f.app.repl.getSnapshot();assert.equal(state.expanded,true);assert.equal(state.viewingHistory,true);assert.ok(state.scrollOffset>0);
		const frame=await snapshot(f);assert.match(frame,/NEWER_06/);assert.doesNotMatch(frame,/REPLY_79/);
		f.stdin.write("\x1b[1;5F");await pause();assert.equal(f.app.repl.getSnapshot().viewingHistory,false);assert.equal(f.app.repl.getSnapshot().scrollOffset,0);
	}finally{f.close();}
});
test("wheel review and Ctrl+O retain the older tool, with collapse and resize preserving its anchor",async()=>{
	const f=fixture();
	try{f.stdin.write("run\r");await until(()=>!f.app.repl.getSnapshot().busy&&f.app.repl.getSnapshot().transcript.some(item=>item.kind==="tool"));await pause();
		f.stdin.write("\x1b[<64;5;5M".repeat(100));await pause();f.stdin.write("\x1b[<65;5;5M".repeat(4));await pause();
		const older=f.app.repl.getSnapshot().transcript.find(item=>item.kind==="tool")!;
		assert.equal(f.app.repl.getSnapshot().viewingHistory,true);f.stdin.write("\x0f");await pause();assert.equal(f.app.repl.getSnapshot().reviewAnchor?.id,older.id);
		assert.match(await snapshot(f),/OLDER_06/);
		f.stdin.write("\x0f");await pause();assert.equal(f.app.repl.getSnapshot().reviewAnchor?.id,older.id);const collapsed=await snapshot(f);assert.match(collapsed,/OLDER_00/);assert.doesNotMatch(collapsed,/OLDER_06/);
		f.stdout.columns=75;f.stdout.emit("resize");await pause();f.stdin.write("\x0f");await pause();assert.equal(f.app.repl.getSnapshot().reviewAnchor?.id,older.id);
		assert.equal(f.app.prompt.getDraft().text,"");
	}finally{f.close();}
});
test("mouse mode is cleaned up and wheel decoding ignores clicks, releases and horizontal scrolling",()=>{
	assert.equal(mouseWheelDirection("\x1b[<64;2;3M"),1);assert.equal(mouseWheelDirection("\x1b[<65;2;3M"),-1);
	for(const raw of ["\x1b[<0;2;3M","\x1b[<64;2;3m","\x1b[<66;2;3M"])assert.equal(mouseWheelDirection(raw),0);
	const f=fixture();f.close();assert.match(f.output(),/\x1b\[\?1000h/);assert.match(f.output(),/\x1b\[\?1000l/);assert.match(f.output(),/\x1b\[\?1006l/);
});
