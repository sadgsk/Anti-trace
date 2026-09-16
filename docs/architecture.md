# CLI Agent 架构书

当前做到哪一步，看 [progress.md](./progress.md)。换对话先读进度，再按这份文档的 **§6** 往下做。

带着写源码的回复格式写在进度文档文首。

对照代码在 `../pi`（`e:\pi-harness\pi`）。路径从 `pi/` 写起。不依赖 `@earendil-works/pi-*`。

**这一版不拿 Pi 的 `AgentSession` 当规范。** 管家是我们自己的 `Harness`：开局把工具 / 模型 / 历史 / 思考等级弄好，之后站在 `main` 和 `Agent` 中间接送。Pi 只当「磁盘长什么样、思考怎么进 API、压缩何时触发」的参考。现有 Agent / loop / 工具 execute 的细节以仓库源码为准，本文不复述。

---

## 0. 怎么用这份文档

1. 按 **§6 实现顺序** 一次只做一步。
2. 写每个文件前，打开 **§5** 里标出的对照，只看点名的函数/类型，不要整包通读。
3. 写完用 **§7** 验收，再进入下一步。
4. 某一刀先瘦，只是分级，不是另开一套 API。session / 压缩 / 思考都挂在同一个 `Harness` 上。

---

## 1. 现在有什么 / 这一版做什么

**已经能用：** REPL；内存多轮对话；`read` / `write` / `edit` / `bash`；流式；abort；`/reset` `/exit`。装配现在写在 `main.ts` 里。消息不落盘。思考等级类型有，没接到模型。不会压缩。

**这一版（v1.2）做管家框架 + 基本功能：**

1. 把工具和系统提示收进 `src/harness/`，`main` 不再 `createXxxTool` / `new Agent`。
2. `Harness`：开局装配；`prompt` 交给 Agent；每轮收尾。
3. 按 cwd 把对话写成 jsonl（一个项目多份聊天）。
4. 上下文过长时自动压缩；可 `/compact`。
5. `/thinking` 能改档位，请求里带上，回复里能出现 thinking 块。

不做：TUI、v4 session、SQLite、会话树 `/tree`、fork、多厂商、Windows bash（No.1）另开。v1.1 的 REPL 手测不挡这一版。

---

## 2. 这一版要做成什么样

```text
main（屏幕）
  you> /reset /exit /new /thinking /compact
  Ctrl+C abort
        │
        ▼
Harness（管家）
  开局：建工具、prompt、new Agent、加载或新建 session
  每句：harness.prompt(text) → agent.prompt(text)
  收尾：写 jsonl；必要时压缩
        │
        ▼
Agent / loop（已有，不改职责）
        ├── tools（搬家后在 harness/tools）
        └── openai-chat（补 thinking 传参和解析）
```

`main` 只做人机：读行、斜杠命令、订阅打印、SIGINT。不创建工具，不 `new Agent`。

磁盘（对齐 Claude Code / Pi 的「按项目分桶」，格式自己定，不抄 v3 树）：

```text
~/.cli-agent/sessions/--<cwd 编码>--/<ISO时间戳>_<id>.jsonl
```

编码：绝对 cwd 去掉开头 `/` `\`，把 `/` `\` `:` 换成 `-`，两边加 `--`。同一目录多个 jsonl = 多次聊天。启动默认**新会话**；`/new` 再开一份；`/resume` 加载该 cwd **mtime 最近**的一份（无选择器）。第一条 assistant 出现才建文件。

jsonl 首行 header，之后每行一条，线性 append，不要 `parentId` 树：

```json
{"type":"session","version":1,"id":"...","timestamp":"...","cwd":"..."}
{"type":"message","message":{...AgentMessage}}
{"type":"thinking_level_change","thinkingLevel":"high"}
{"type":"compaction","summary":"...","keptMessages":[...]}
```

压缩阈值对齐 Pi 公式，不抄分支摘要：

```text
contextTokens > contextWindow - reserveTokens
```

默认 `reserveTokens = 16384`。`Model` 若无 `contextWindow` 则用常量 `128000`。token 没有 usage 时按字符/4 估。保留尾部大约 `keepRecentTokens = 20000`。磁盘保留全文；发给模型的是摘要 + 尾部。`/reset` 清内存并 `/new` 等价（旧文件留下）。

---

## 3. 文件清单

搬家（函数体不动，只改路径和 import）：

```
src/tools/*          → src/harness/tools/*
src/prompt.ts        → src/harness/prompt.ts
```

要改 import 的：`src/cli/main.ts`、`src/index.ts`、`test/probe-read.ts`、`probe-write.ts`、`probe-edit.ts`、`probe-bash.ts`。

新建：

```
src/harness/harness.ts
src/harness/session.ts
src/harness/compaction.ts
test/probe-harness.ts
test/probe-session.ts
```

装配：

- `src/cli/main.ts`：`new Harness(...)`，`you>` 走 `harness.prompt`；斜杠 `/new` `/resume` `/thinking` `/compact`
- `src/agent/agent.ts`：`createLoopConfig` 补上 `reasoning`（同一函数加厚，不另写 stream）
- `src/llm/openai-chat.ts`：请求带 `reasoning_effort`；SSE 解析 `reasoning_content`
- `src/types.ts`：`StreamOptions.reasoning`；`Model.contextWindow?`
- `src/index.ts`：导出 `Harness`；工具 create 函数改新路径

---

## 4. 分层

```
cli/main.ts + render.ts
   │
   ▼
harness/harness.ts
   ├── harness/tools/*     开局挂上
   ├── harness/prompt.ts
   ├── harness/session.ts  读写 jsonl
   ├── harness/compaction.ts
   ▼
Agent / loop
   └── llm/openai-chat.ts
```

`env.ts` 仍在 `src/` 根上，只读 key。不进管家。

---

## 5. 模块说明书

### 5.0 搬家

`src/tools/` 四个工具 + `path-utils.ts` 移到 `src/harness/tools/`。`prompt.ts` 移到 `src/harness/prompt.ts`。`createXxxTool` / `buildSystemPrompt` 签名不变。探针和 `index.ts` 改 import。做完：`npm start` 和现有 probe 与搬家前一样。

---

### 5.1 `src/harness/harness.ts`

**做什么：** `Harness` 类。开局装配；之后 `main` 只跟它说话。

```ts
export interface HarnessOptions {
  cwd: string;
  apiKey: string;
  model: Model;
  streamFn: StreamFn;
}

export class Harness {
  constructor(options: HarnessOptions);
  readonly agent: Agent; // SIGINT / render 需要 isStreaming、abort、subscribe
  prompt(text: string): Promise<void>;
  reset(): void;
  abort(): void;
  subscribe(listener: ...): () => void;
  newSession(): void;
  resumeRecent(): boolean; // 没有可 resume 的文件则 false
  setThinkingLevel(level: ThinkingLevel): void;
  compact(customInstructions?: string): Promise<void>;
}
```

**第一刀（框架）：** 构造时 `createRead/Write/Edit/BashTool(cwd)`，`buildSystemPrompt`，`new Agent({ tools, streamFn, apiKey, initialState })`。`prompt` / `reset` / `abort` / `subscribe` 转给 Agent。`newSession` / `resumeRecent` / `setThinkingLevel` / `compact` 可以先空实现或 throw「未接上」，下一步再填，但方法名这一刀就定下来。

**对照：** 不读 `agent-session.ts`。角色相当于 Pi 的管家，API 按上面这份，不要抄 extensions / 队列 / 树导航。

---

### 5.2 `src/harness/session.ts`

**做什么：** cwd 目录编码、建文件、append、读回 `AgentMessage[]` + 最后一次思考档位。

- `sessionDirForCwd(cwd): string` → `~/.cli-agent/sessions/--encoded--/`
- `createSessionFile(...)` 只准备路径，第一条 assistant 才 `writeFile` header + 已攒的行
- `appendEntry(entry)`
- `loadSession(path): { messages, thinkingLevel }`
- `findMostRecentSession(cwd): string | undefined` 按 mtime

不写树，不写 lane。compaction / thinking 行的读写也走这里，类型放在 `session.ts`。

**对照：** `pi/packages/coding-agent/src/core/session-manager.ts` 的 `getDefaultSessionDirPath`（约 476–480 行）和 `_persist` 里「先有 assistant 再落盘」（约 1015–1041 行）。只借这两点。不要抄 `parentId`、label、fork。

---

### 5.3 `src/harness/compaction.ts`

**做什么：** `shouldCompact(contextTokens, contextWindow, settings)`；准备切点；调一次 LLM 做摘要；返回 `{ summary, keptMessages }`。

默认：`enabled: true`，`reserveTokens: 16384`，`keepRecentTokens: 20000`。

Harness 在每次 `prompt` 结束后：用最后一条 assistant 的 usage（没有就估）判断；为真则 compact，把 `agent.state.messages` 换成「一条摘要 user/assistant 自定义消息 + kept」，session 写 `compaction` 行。`/compact` 同一条路径。

切点：从最新往回累加估计 token，够 `keepRecentTokens` 停下；不要切在 `toolResult` 上（避免孤儿 tool）。摘要 prompt 第一刀用短系统提示 + 把要压的消息序列化成文本，走现有 `streamFn`，不带 tools。

不做：分支摘要、溢出后自动 retry、文件列表元数据。思考块这一步还没有，摘要按普通文本处理即可。

**对照：** `pi/packages/agent/src/harness/compaction/compaction.ts` 的 `DEFAULT_COMPACTION_SETTINGS`、`shouldCompact`（约 158–162、247–250 行）。算法细节第一刀按上面做瘦的，不要整文件移植。

---

### 5.4 思考等级

已有 `ThinkingLevel`、`agent.state.thinkingLevel`、loop 的 `thinking_*` 事件。这一版接通。

1. `StreamOptions` 增加 `reasoning?: ThinkingLevel`。
2. `Agent.createLoopConfig`：`reasoning: thinkingLevel === "off" ? undefined : thinkingLevel`。
3. `openai-chat.ts`：`reasoning` 存在则 body 加 `reasoning_effort`（字符串就是档位名）。SSE delta 里 `reasoning_content` 或 `reasoning` → `thinking_*` 事件，写入 `ThinkingContent`。
4. `Harness.setThinkingLevel` 改 `agent.state.thinkingLevel`，session 追加 `thinking_level_change`。
5. `main`：`/thinking` 无参数打印当前档；`/thinking off|minimal|low|medium|high` 调用 set。

不做：`xhigh`/`max`、thinkingFormat 全家桶、token budget。

**对照：** `pi/packages/agent/src/agent.ts` `createLoopConfig` 里 `reasoning:` 那一行（约 450 行）；`pi/packages/ai/src/api/openai-completions.ts` 里设 `reasoning_effort` 和读 `reasoning_content` 的局部。不要通读 openai-completions 全文。

---

### 5.5 `main.ts` 装配

启动：`getOpenAIConfig` + `new Harness({ cwd, apiKey, model, streamFn: streamOpenAIChat })`，`subscribe(renderEvent)`。

循环：普通行 → `harness.prompt(line)`。`/exit` 照旧。`/reset` → `harness.reset()`（清消息并 newSession）。`/new` → `newSession`。`/resume` → `resumeRecent`，没有则打印一句。`/thinking`、`/compact` 接到 harness。SIGINT：streaming 则 `harness.abort()`。

---

## 6. 推荐实现顺序

一次一步。每步能 `tsc --noEmit`。搬家不改工具函数体。


| 步 | 做哪些文件 | 做完时你应该能证明什么 | 主要对照 |
|---|---|---|---|
| 0 | 搬家 tools / prompt，改 import | 现有 probe 全过；REPL 行为与搬家前相同 | 无（改路径） |
| 1 | `harness.ts` + `probe-harness.ts`；`main.ts` 改用 Harness | `main` 不再 import createXxxTool；假 stream 能 prompt | 无（自己的 API） |
| 2 | `session.ts` + `probe-session.ts`；Harness 写入/加载 | 临时 cwd 聊一句磁盘上有 jsonl；进程外读回 messages | `getDefaultSessionDirPath`、`_persist` 延迟建文件 |
| 3 | `compaction.ts`；Harness 回合后检查 + `/compact` | 造一串超阈值消息能变成摘要+尾部；jsonl 多一行 compaction | `shouldCompact`、默认常量 |
| 4 | types + `createLoopConfig` + `openai-chat` + `/thinking` | `/thinking high` 后请求带 `reasoning_effort`；有 thinking 的模型能打出思考（没有则档位仍能存盘） | agent.ts `reasoning:`；openai-completions 局部 |
| 5 | REPL 按 §7 手测 | §7 清单打勾 | — |

session / compaction 探针只用临时目录，不要往 `src/` 或用户家目录的真实项目会话里写测试数据（probe 可把根目录指到 tmp，或抽 `sessionsRoot` 参数，默认 `~/.cli-agent/sessions`）。

---

## 7. 这一版验收

设好 `OPENAI_API_KEY`。`npm start`。

1. 普通对话 + `read` `package.json` 仍能工作（框架没把工具弄丢）。
2. 说一句话之后，`~/.cli-agent/sessions/--...--/` 下出现 jsonl，里面有 user / assistant。
3. `/new` 后再说一句，同目录多一个文件。
4. 退出再启动，`/resume` 能接上最近那份（能问「我刚才说了什么」对得上）。
5. `/compact` 或撑过阈值后，再问模型时上下文是摘要+最近消息，不是整段原文；jsonl 有 `compaction` 行。
6. `/thinking medium`（或 high）不报错；jsonl 有 `thinking_level_change`。模型若支持 `reasoning_effort`，屏幕上能看到思考或至少请求里带了该字段（probe 可断言 body）。
7. `/reset` 后工具还能用，且开始一份新会话。

测完删掉临时 jsonl 和手测写的文件。

---

## 8. 先别通读的 Pi 文件

| 文件 | 现在先不看的原因 |
|---|---|
| `coding-agent/src/core/agent-session.ts` | 产品管家，不是这一版规范 |
| `agent/src/harness/agent-harness.ts` | 未完成的 v4 运行时 |
| `agent/src/harness/session/**`（v4） | 不抄 v4 header / lane |
| `session-backends/sqlite-node/**` | 不用 SQLite |
| `coding-agent/src/modes/interactive/**` | TUI |
| `ai/src/api/openai-completions.ts` 全文 | 只看 reasoning 局部 |

这一版精读：

1. `session-manager.ts`：`getDefaultSessionDirPath`、`_persist` 延迟建文件
2. `agent.ts`：`createLoopConfig` 的 `reasoning`
3. `openai-completions.ts`：`reasoning_effort`、`reasoning_content` 两处
4. `harness/compaction/compaction.ts`：默认常量和 `shouldCompact`
5. 仓库里现有的 `src/agent/agent.ts`、`src/llm/openai-chat.ts`、`src/cli/main.ts`

---

## 9. 和 Pi 的对应

```
这一版                            Pi（参考，不当规范）
────────────────────────────────────────────────────
src/harness/harness.ts            角色 ≈ AgentSession，API 自定
src/harness/session.ts            目录编码 / jsonl append 的思路
src/harness/compaction.ts         shouldCompact + 默认阈值
src/harness/tools/*               agent/harness/tools/*（已有，只搬家）
src/harness/prompt.ts             原 src/prompt.ts
createLoopConfig.reasoning        agent.ts 同名补丁
openai-chat reasoning             openai-completions 局部
cli/main.ts                       interactive-mode 的输入循环（readline）
```
