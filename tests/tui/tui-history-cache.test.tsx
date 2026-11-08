import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { TranscriptLayoutCache } from "../../src/tui/layout/TranscriptLayoutCache.tsx";
import { RowRenderer } from "../../src/tui/layout/RowRenderer.tsx";
import { TranscriptItemView, type TranscriptGroup } from "../../src/tui/messages/TranscriptView.tsx";
import { theme } from "../../src/tui/theme/theme.ts";
import { ArrayRows, appendRows } from "../../src/tui/layout/terminal-rows.ts";
import { ScrollbackOutput } from "../../src/cli/ink/scrollback-output.ts";
import { Writable } from "node:stream";
const options = { columns: 79, expanded: true, thinkingDisplay: true, theme, language: "zh" as const };
const clean = (rows: string[]) => rows.map(row => row.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());
const assistant = (text: string): TranscriptGroup => ({id: 1, kind: "assistant", timestamp: 0, blocks:[{kind:"text",index:0,text}]});

test("cached Markdown and segmented code preserve the existing rows, borders, numbers and full lexical context", () => {
  const renderer = new RowRenderer(), cache = new TranscriptLayoutCache();
  try {
    for (const text of ["Hello **world**!", "# heading\n\nparagraph\n\n- one\n- two\n\n> quote\n\n---\n\n| A | B |\n|---|---|\n| 中文 | x |", "```typescript\n/*\n" + Array.from({length:150},(_,i)=>`const value_${i} = ${i};`).join("\n") + "\n*/\nconst done = true;\n```", "[reference][id]\n\n[id]: https://example.com"]) {
      const item = assistant(text);
      const expected = renderer.rows(<TranscriptItemView item={item} {...options}/>,79,theme,"zh");
      const actual = cache.prepare([item],null,"",options).slice(0);
      assert.deepEqual(clean(actual),clean(expected));
    }
  } finally { renderer.dispose(); cache.dispose(); }
});

test("thinking segments preserve exact wrapping including Chinese and emoji", () => {
  const renderer = new RowRenderer(), cache = new TranscriptLayoutCache();
  try {
    const item: TranscriptGroup = { id:1,kind:"assistant",timestamp:0,blocks:[{kind:"thinking",index:0,text:"中文🙂👩‍💻换行连续性 wrap continuity ".repeat(800)}]};
    assert.deepEqual(clean(cache.prepare([item],null,"",options).slice(0)),clean(renderer.rows(<TranscriptItemView item={item} {...options}/>,79,theme,"zh")));
  } finally { renderer.dispose(); cache.dispose(); }
});

test("row cache eviction keeps height and allows lossless random access", () => {
  const cache = new TranscriptLayoutCache(20000);
  try {
    const items = Array.from({length:200},(_,i):TranscriptGroup=>({id:i,kind:"notice",tone:"info",text:`NOTICE_${i}`}));
    const layout = cache.prepare(items,null,"",options);
    assert.ok(cache.cachedBytes<=20000);
    const rows = clean(layout.slice(0));
    for (let i=0;i<200;i++) assert.ok(rows.some(row=>row.includes(`NOTICE_${i}`)));
    const oldLength=layout.length;
    for(let i=0;i<100;i++) layout.slice(i*2,i*2+8);
    assert.equal(layout.length,oldLength); assert.ok(cache.cachedBytes<=20000);
  } finally {cache.dispose();}
});

test("native output reads only visible rows after the initial replay",()=>{
  const writes:string[]=[];
  const stdout=Object.assign(new Writable({write(chunk,_encoding,done){writes.push(chunk.toString());done();}}),{columns:80,rows:28});
  const writer=new ScrollbackOutput(stdout as any);
  let readRows=0;
  const source={length:10000,slice(start:number,end=10000){if(start<0)start+=10000;readRows+=end-start;return Array.from({length:end-start},(_,i)=>`ROW_${start+i}`);}};
  writer.write(source); readRows=0; writes.length=0;
  writer.write(source);
  assert.ok(readRows<=112,`read ${readRows} rows`); assert.equal(writes.length,0);
  const joined=appendRows(source,["NEW_ROW"]);
  readRows=0;writer.write(joined);assert.ok(readRows<=112);assert.match(writes.join(""),/NEW_ROW/);assert.doesNotMatch(writes.join(""),/ROW_100\b/);
  stdout.destroy();
});


test("cold history and width/expansion changes lay out only the visited window",()=>{
  const cache=new TranscriptLayoutCache();
  let layouts=0;
  const renderer=(cache as any).renderer, original=renderer.rows.bind(renderer);
  renderer.rows=(...args:any[])=>{layouts++;return original(...args);};
  try {
    const items=Array.from({length:1000},(_,id):TranscriptGroup=>({id,kind:"assistant",timestamp:0,blocks:[{index:0,kind:"text",text:`# Message ${id}\n\n`+"visible message ".repeat(20)}]}));
    let layout=cache.prepare(items,null,"",options);
    layout.ensureTail(40); layout.slice(-24);
    assert.ok(layouts<30,`${layouts} layouts for cold tail`);
    layouts=0;
    layout=cache.prepare(items,null,"",{...options,columns:55,expanded:false});
    layout.ensureTail(40); layout.slice(-24);
    assert.ok(layouts<30,`${layouts} layouts for resized tail`);
    layouts=0;
    layout.ensureAnchor({id:500,row:0},40);
    const top=layout.resolve({id:500,row:0})!;
    assert.match(layout.slice(top,top+24).join("\n"),/Message 500/);
    assert.ok(layouts<30,`${layouts} layouts when jumping to one message`);
  } finally {cache.dispose();}
});

test("a ten-thousand-line code block keeps its offscreen segments out of layout",()=>{
  const cache=new TranscriptLayoutCache();
  let layouts=0;
  const renderer=(cache as any).renderer, original=renderer.rows.bind(renderer);
  renderer.rows=(...args:any[])=>{layouts++;return original(...args);};
  try {
    const item=assistant("```text\n"+Array.from({length:10000},(_,i)=>`CODE_${i} value`).join("\n")+"\n```");
    const layout=cache.prepare([item],null,"",options);
    layout.ensureTail(40);
    assert.match(layout.slice(-28).join("\n"),/CODE_9999/);
    assert.ok(layouts<=5,`laid out ${layouts} chunks instead of the visible tail`);
    assert.ok(cache.cachedBytes<200000);
  } finally {cache.dispose();}
});

test("returning to a cached layout variant retains exact native-history heights",()=>{
  const cache=new TranscriptLayoutCache();
  try {
    const items=Array.from({length:100},(_,id):TranscriptGroup=>({id,kind:"assistant",timestamp:0,blocks:[{index:0,kind:"thinking",text:"thinking ".repeat(50)}]}));
    const native=cache.prepare(items,null,"",{...options,expanded:false,thinkingDisplay:false});
    const nativeRows=native.slice(0);
    const review=cache.prepare(items,null,"",options);review.ensureTail(40);review.slice(-28);
    const restored=cache.prepare(items,null,"",{...options,expanded:false,thinkingDisplay:false});
    assert.equal(restored.length,nativeRows.length);
    assert.deepEqual(restored.slice(-28),nativeRows.slice(-28));
  } finally {cache.dispose();}
});
