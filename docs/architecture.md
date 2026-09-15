# CLI Agent 架构书

当前做到哪一步，看 [progress.md](./progress.md)。换对话先读进度，再按这份文档的 **§6** 往下做。

带着写源码的回复格式写在进度文档文首。

对照代码在 `../pi`（`e:\pi-harness\pi`）。路径从 `pi/` 写起。不依赖 `@earendil-works/pi-*`，做法对齐 Pi 的 harness 工具。

现有 loop / Agent / StreamFn 的细节以仓库源码为准，本文不复述。

---

## 0. 怎么用这份文档

1. 按 **§6 实现顺序** 一次只做一个文件（或一组紧耦合文件）。
2. 写每个文件前，打开 **§5** 里的 Pi 对照，只看标出的函数/类型，不要整包通读。
3. 写完用 **§7** 验收，再进入下一步。
4. 目标是 Pi 那种产品级工具（schema、唯一匹配、截断、路径解析）。某一刀先做瘦实现，只是把问题分级，下一刀再补到同一套接口上，不要另开一套「玩具 API」。

---

## 1. 现在有什么 / 这一版做什么

**已经能用：** `npm start` 进 REPL；多轮对话（内存里的 messages）；`bash` 跑命令；流式打字；工具起止打印；`Ctrl+C` abort；`/reset` `/exit`。OpenAI-compatible Chat Completions。

**这一版（v1.1）只加工具：** `read`、`write`、`edit`，和 Pi harness 那三个对齐。`bash` 留下。session、compaction、TUI、多厂商等下一版再开。

---

## 2. 这一版要做成什么样

REPL 里模型可以读文件、整文件写、按精确文本改一处或多处，不必再靠 `type`/`echo` 硬来。

四个 `AgentTool` 一起交给 `Agent`。系统提示列出工具名和各自干什么。

对齐 Pi：

- `AgentTool = 说明书 + execute(toolCallId, params, signal, onUpdate)`
- 参数用 TypeBox schema
- 路径相对 `cwd` resolve 成绝对路径（Pi 用 harness `env.absolutePath`；这边用 Node `path` + `cwd`。不拦工作区外，和 Pi 一样）
- 业务失败（找不到文件、`oldText` 不唯一）**throw**，loop 已有的协议会变成 `isError` toolResult
- `signal` abort 时 throw

---

## 3. 文件清单

新建：

```
src/tools/path-utils.ts 路径解析（给三个文件工具共用，不是独立工具）
src/tools/read.ts
src/tools/write.ts
src/tools/edit.ts
test/probe-read.ts
test/probe-write.ts
test/probe-edit.ts
```

装配（现有文件上加工具，不另起炉灶）：

- `src/cli/main.ts`：`tools` 数组加上三个 `createXxxTool(cwd)`
- `src/prompt.ts`：系统提示写清 read / write / edit / bash
- `src/index.ts`：re-export 三个 create 函数

---

## 4. 分层（只标这一版新挂上的）

```
main.ts  装配 tools: [bash, read, write, edit]
   │
   ▼
Agent / loop   （已有，源码里读）
   │
   └─ 每个 toolCall → AgentTool.execute
         read.ts / write.ts / edit.ts / bash.ts
```

事件协议不变。`render.ts` 已经按 `toolName` 打印。

---

## 5. 模块说明书

写文件前只看本节标出的 Pi 段。产品级细节以 harness 那份为准；coding-agent 里带 TUI 的工具当「以后看」，第一刀不要跟。

---

### 5.0 `src/tools/path-utils.ts`

**做什么：** `resolveCwdPath(cwd, inputPath, signal?): string`（或 async，若你要跟 Pi 一样可中断）。

Pi 的 `env.absolutePath` 负责：规范化、变成绝对路径。不限制必须在工作区里。这边没有 harness env，用 `node:path`：

1. `path.resolve(cwd, input)`。相对路径锚在 `cwd`，绝对路径原样规范化。
2. 返回绝对路径。

**对照：** `pi/packages/agent/src/harness/tools/path-utils.ts` 的 `normalizeToolPath`、`resolveToolPath`；`env/nodejs.ts` 的 `resolvePath`。第一刀不剥 `@`（这边还没有 `@` mention），不展开 `~` / `file://`，也不抄 Unicode 空格 / NFD 变体。后一刀仍加在同一个 `resolveCwdPath` 上。不额外加工作区铁墙。

---

### 5.1 `src/tools/read.ts`

**做什么：** `createReadTool(cwd): AgentTool`。

Schema 跟 Pi：

```ts
Type.Object({
  path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
  offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-indexed)" })),
  limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
})
```

**第一刀（文本）：**

1. `resolveCwdPath` → `fs.readFile` utf8。
2. 按行 `offset`/`limit`。
3. 行号格式化后返回。超大则截断并注明用 offset 继续。上限对齐 Pi 的 `DEFAULT_MAX_LINES` / `DEFAULT_MAX_BYTES`（`harness/utils/truncate.ts`），读那个常量即可。
4. 文件不存在 throw。

**后一刀（同一工具上补）：** 图片走 `ImageContent`（jpg/png/gif/webp）。对照 `read.ts` 里 `detectSupportedImageMimeType` 那段。第一刀验收不挡文本。

**对照：** `pi/packages/agent/src/harness/tools/read.ts` 的 `readSchema`、`createReadTool`、`execute`。不要抄 harness `env.readBinaryFile` 的接口形状——换成 `node:fs`，行为对齐。不要抄 coding-agent 那份带 TUI 的 read。

---

### 5.2 `src/tools/write.ts`

**做什么：** `createWriteTool(cwd): AgentTool`。

Schema 跟 Pi：

```ts
Type.Object({
  path: Type.String({ description: "Path to the file to write (relative or absolute)" }),
  content: Type.String({ description: "Content to write to the file" }),
})
```

`execute`：resolve → 创建父目录 → 覆盖写入 → 返回写了多少字节。`signal` abort 则 throw。

**对照：** `pi/packages/agent/src/harness/tools/write.ts` 全文很短。`withFileMutationQueue` 是防并发写同一文件；第一刀可以先直接写，后一刀再加队列，函数还是 `createWriteTool`。

---

### 5.3 `src/tools/edit.ts`

**做什么：** `createEditTool(cwd): AgentTool`。

目标 schema 跟 Pi：`path` + `edits: { oldText, newText }[]`。每段 `oldText` 在**原文件**上必须恰好出现一次，且互不重叠。

**第一刀：** 先实现「数组里可以有多项，每项对原文件做唯一替换」，写回。匹配 0 次或 ≥2 次 throw。

**后一刀：** Pi 的 `prepareEditArguments`（legacy `oldText`/`newText` 顶栏、`edits` 被加成字符串时 JSON.parse）、换行归一、`details` 里的 diff/patch。接口仍是 `createEditTool`。

**对照：** `pi/packages/agent/src/harness/tools/edit.ts` 的 schema、`validateEditInput`、execute 主路径。diff 在 `edit-diff.ts`，后一刀再读。

---

### 5.4 装配

`main.ts`：四个工具推进 `initialState.tools`，`buildSystemPrompt({ cwd, toolNames })` 带上四个名字。

`prompt.ts`：说明 read 读文件、edit 改一处、write 整文件、bash 跑命令。继续用 options 对象。

`index.ts`：导出三个 `createXxxTool`。

---

## 6. 推荐实现顺序

一次一步。每步能 typecheck。简化只出现在「这一刀做多厚」，不改名字、不改 schema 方向。


| 步 | 做哪些文件 | 做完时你应该能证明什么 | 主要对照 |
|---|---|---|---|
| 0 | `src/tools/path-utils.ts` | 相对路径能 resolve；绝对路径 / `..` 不因越界 throw | `path-utils.ts` `normalizeToolPath` / `resolveToolPath` |
| 1 | `read.ts` + `test/probe-read.ts` | 读小文件带行号；缺文件 throw；cwd 外绝对路径能读；超大截断 | `read.ts` 文本 execute + `truncate.ts` 上限 |
| 2 | `write.ts` + `test/probe-write.ts` | 临时目录写入再读回 | `write.ts` |
| 3 | `edit.ts` + `test/probe-edit.ts` | 一处成功；0 次 / 2 次 throw；两项不重叠能都换上 | `edit.ts` schema + validate |
| 4 | `main.ts` `prompt.ts` `index.ts` | REPL 里 `read` `package.json` 能看到 `[read]` | 现有 main 装配 |

write/edit 探针只用临时目录，不要改 `src/` 里的真源码。

图片 read、mutation queue、edit diff：同一文件上往后补，不必新开工具名。

---

## 7. 这一版验收

设好 `OPENAI_API_KEY`。`npm start`。

1. 「读 `package.json` 的 name」→ `[read]`，回答里有 `cli-agent`。
2. 「write 一个 `tmp-v1.1-note.txt`，内容 hello」→ `[write]`，磁盘上有文件。
3. 「把 hello 改成 world」→ `[edit]`，文件变成 world。
4. bash 再读这个文件，和 edit 一致。
5. 让它读工作区外面一份存在的文件 → `[read]` 能读到，不报越界。
6. `/reset` 之后工具还能用。

测完删掉临时文件。

---

## 8. 先别通读的 Pi 文件

通读这些会把这一版带去 session/TUI，等对应功能再看：

| 文件 | 现在先不看的原因 |
|---|---|
| `agent/src/harness/session/**` | 持久化，下一版 |
| `agent/src/harness/compaction/**` | 压缩，下一版 |
| `coding-agent/src/core/tools/*.ts` | 产品 TUI 工具 |
| `coding-agent/src/core/agent-session.ts` | Agent + session + extensions |
| `ai/src/api/openai-completions.ts` 全文 | 工具层用不到 |

这一版精读：

1. `pi/packages/agent/src/harness/tools/read.ts`
2. 同上 `write.ts`
3. 同上 `edit.ts`
4. `path-utils.ts`
5. `harness/utils/truncate.ts`（上限常量）
6. 仓库里现有的 `src/tools/bash.ts`（你们的 `AgentTool` 形状）

---

## 9. 和 Pi 的对应

```
这一版                         Pi
──────────────────────────────────────────────
src/tools/path-utils.ts        harness/tools/path-utils.ts
src/tools/read.ts              harness/tools/read.ts
src/tools/write.ts             harness/tools/write.ts
src/tools/edit.ts              harness/tools/edit.ts
main / prompt / index          现有装配上加工具
```
