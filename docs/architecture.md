# CLI Agent 架构书

项目目标是逐步构建一个可开源、可持续使用和演进的产品级个人 CLI agent。开发过程同时服务于用户理解源码：先参考 Pi，从简单到复杂补齐能力，再持续加入自己的设计和想法。学习决定每次推进的大小，产品目标决定框架和功能的设计。

本文只保存**当前有效的设计、实际项目状态和已确定的后续目标**。开发历史、当前版本待办和验收记录见 [progress.md](./progress.md)。新对话先读进度，再根据本文了解设计；不需要从旧版决策中拼出当前规则。

对照代码在 `../pi`（`e:\pi-harness\pi`），下文参考路径从 `pi/` 写起。当前项目独立实现，不依赖 `@earendil-works/pi-*`。

---

## 0. 产品方向与推进方式

### 0.1 框架先确定，实现分小步

- 当前优先补齐已经规划的核心能力，做出能完整运行的 agent。产品级是持续建设的目标；每个版本交付其中一部分，不以练手为由刻意降低实现质量。
- 对已确定的模块职责、数据流和近期功能，能一次搭好的框架就先搭好。接口、类型和函数入口可以先保留，后续沿同一套设计填充，减少因临时方案造成的反复重构。
- 预留入口标明未实现，不把占位当成可用功能。框架先行不等于提前实现全部功能，也不为尚未确定的需求铺设大量兼容分支和兜底。
- 一次最多改三个函数（含必要类型和接线），超出的留到下一批。每批改之前先说明要动哪几个函数、各自做什么，写完等用户 review 再继续。版本目标可以跨多批完成；例如上下文容量是一个版本目标，不要求一次写完窗口、计量、显示和压缩。
- 一个功能全部实现完再开始测试，验证方式和结果在功能完成后一起交代。实现过程中发现设计冲突、边界或影响面问题，当场说明，不留到 review 之后。允许修改已有函数、填充占位和调整必要的类型；减少返工是设计目标，不是「代码写过就不能再改」的禁令。

### 0.2 Pi 是参考，产品设计由本项目决定

Pi 提供起始框架和源码学习材料，不要求逐项复刻它的 API、交互或实现。当前使用自己的 `Harness` 承担装配和会话管理，具体职责见 §4。现有 Agent / loop / 工具执行细节以源码为准。

图片粘贴、会话命名等功能按用户希望的行为设计；可以参考 Claude Code 或其他实现，也可以独立设计。讲解时说明借鉴了什么、为何不同，自定义部分不需要勉强寻找 Pi 对照。

阅读 Pi 时，优先看当前小点涉及的函数和调用方；需要理解上下文时再扩展阅读。§5、§8 的位置是阅读入口，不是禁止阅读其他文件的约束。

### 0.3 文档只保留有效状态

- 架构书回答“现在是什么、接下来做什么、为何这样设计”，不保留已经失效的方案和施工历史。状态或目标更新时直接改对应段落，避免不断追加互相覆盖的补充规则。
- 进度文档保存历史改动，以及当前版本已完成、已起步、未完成和待验收的事项。实现、设计决定和验证结果分别写清，不能把“决定要做”写成“已经做完”。
- 每完成一个小点，同步当前状态和进度；版本完成后，由用户确定下一阶段目标，再更新架构书。旧版本的过程留在进度文档和 Git 历史中。
- 本文的“本版不做”只限定当前交付范围，不是永久禁止。用户已确定的实现和版本目标保持有效；调整目标时同步更新当前设计，避免新旧规则并存。

---

## 1. 现在有什么 / 这一版做什么

| 能力 | 当前状态 |
|---|---|
| 对话与工具 | REPL、内存多轮对话、`read` / `write` / `edit` / `bash`、流式和 abort 已实现；已知问题及验收状态见进度和问题记录 |
| 装配与会话 | 工具和系统提示在 `src/harness/`；`Harness` 装配 Agent，按 cwd 保存 jsonl；`/new` `/resume` `/exit` 已接通 |
| 图片输入 | `read` 支持 jpeg/png/gif/webp；CLI 支持剪贴板图片，Windows `Alt+V`、macOS/Linux `Ctrl+V`，位图优先、文件路径其次；发送前尝试把最长边缩到 2000，只处理临时副本；文字和图片进入同一条内部消息，当前不按模型能力拦截图片 |
| 协议适配 | 当前只实现 OpenAI Chat Completions，用于运行和测试；消息转换在 `openai-chat.ts`，内部保留内容块结构；含图工具结果在整批 tool 回复后按来源分组、保留图文顺序发送，已通过本地请求体验收 |
| 上下文容量 | 窗口、估算用量和显示已接通：`Model.contextWindow`（`env.ts` 读 `OPENAI_CONTEXT_WINDOW`，缺省 `128000`）、`Harness.setContextWindow` / `contextUsage`、REPL `/context` 和每轮后的 `ctx used/window`；`estimateTokens` / `estimateMessagesTokens` 承担估算。摘要和自动压缩尚未接通 |
| 思考等级 | 已有类型、状态和事件；尚未接到模型请求与 CLI。`setThinkingLevel` / `compact` 仍是 throw「未接上」的预留入口 |

**这一版（v1.2）的既定目标：**

1. 把工具和系统提示收进 `src/harness/`，`main` 不再 `createXxxTool` / `new Agent`。
2. `Harness`：开局装配；`prompt` 交给 Agent；每轮收尾。
3. 按 cwd 把对话写成 jsonl（一个项目多份聊天）。会话名从第一条用户消息截出来，不另跑模型起名；`/resume` 用「名字 + 上次打开时间」分辨。
4. **上下文容量**（一个完整功能，分小点实现）：窗口设置、用量记录、REPL 显示、过长则压缩。
5. `/thinking` 能改档位，请求里带上，回复里能出现 thinking 块。

图片读取与粘贴也是当前能力的一部分，按本项目的交互设计保留；它们不替代上述尚未完成的目标。

**后续范围：** BYOK 已确定后续实现，当前继续用 OpenAI 格式测试。TUI、v4 session、SQLite、会话树 `/tree`、fork、多厂商不纳入 v1.2；Windows bash 问题（No.1）单独安排。本文不为这些事项新增版本号或排期，下一阶段由用户在版本收尾时确定。v1.1 遗留手测继续在进度里记录，不阻塞 v1.2 开发。

---

## 2. v1.2 目标行为

以下包含已接通的会话能力和待接通的上下文、思考能力；当前实现状态以 §1 和进度文档为准。

```text
main（屏幕）
  you> /exit /new /resume /thinking /context
  每轮后一行 ctx used/window
  Ctrl+C abort
        │
        ▼
Harness（管家）
  开局：建工具、prompt、new Agent、加载或新建 session
  每句：harness.prompt(text, images?) → agent.prompt(text, images?)
  消息落定：写 jsonl；收尾：更新用量，必要时压缩
        │
        ▼
Agent / loop（已有，不改职责）
        ├── tools（harness/tools）
        └── openai-chat（补 thinking 传参和解析）
```

`main` 只做人机：读行、斜杠命令、订阅打印、SIGINT。不创建工具，不 `new Agent`。

磁盘采用按项目分桶的线性会话，格式由本项目定义：

```text
~/.cli-agent/sessions/--<cwd 编码>--/<ISO时间戳>_<id>.jsonl
```

编码：绝对 cwd 去掉开头 `/` `\`，把 `/` `\` `:` 换成 `-`，两边加 `--`。同一目录多个 jsonl = 多次聊天。启动默认**新会话**；`/new` 再开一份。第一条 assistant 出现才建文件。

**会话名：**

- 取第一条 user 消息的纯文本（空白收成单空格），截到最多 **10 个字符**；不够 10 个就全留下。空则 `untitled`。
- 当前命名不调用 LLM，不提供 `/name`，名字存入 header。
- 名字写进 header 的 `name`：内存里 `createSessionFile` 时还没有用户话；**第一次 flush**（首条 assistant 落盘）时已经有 user 消息，那时填上，之后不改。
- 上次打开时间用该 jsonl 的 **mtime**。`/resume` 加载时 `touch` 一下，即使没再说话也算打开过。

**`/resume`（REPL 打印几行，不是 TUI 选择器）：**

- 列出当前 cwd 桶内已落盘的会话，按上次打开时间新到旧，每行：`序号. 名字  YYYY-MM-DD HH:mm`。
- `/resume`：打印列表，再读一行序号，调用 `resumeAt`。空行取消，不加载。
- 只有整行恰好是 `/resume` 才进这条命令；`/resume 2` 这类不算。
- 没有可 resume 的文件则打印一句，不 throw。不自动打开最近一份。

jsonl 首行 header，之后每行一条，当前使用线性 append，不包含 `parentId` 树：

```json
{"type":"session","version":1,"id":"...","timestamp":"...","cwd":"...","name":"帮我改一下"}
{"type":"message","message":{...AgentMessage}}
{"type":"compaction","summary":"...","keptMessages":[...]}
```

**思考等级（跟 harness，不跟 session）：**

- 开局在 `agent.state.thinkingLevel`，默认 `off`。`/thinking` 只改这一份。
- `/new` `/resume` 不改档位。resume 只灌 messages（和名字），不从 jsonl 读 thinking。
- 当前 jsonl 不单独写 thinking 档位变更行。

**上下文容量**先有窗口和用量。压缩在用量过线，或这轮回复表明上下文装不下时自动发生。

1. **窗口：** 数字在 `Model.contextWindow`。这一版用 `.env` 的 `OPENAI_CONTEXT_WINDOW` 填进去，缺省 `128000`，填错就按填的用。以后配置模型时，这一项跟在那条模型上，不再单独靠环境变量。`/context <正整数>` 只改本进程这份 `Model.contextWindow`。
2. **记录：** 优先用接口返回的 usage（后续给 `AssistantMessage` 补上）；没有则用现有 `estimateTokens` 估算，文字按字符/4、图片按固定开销估。Harness 记住当前 `usedTokens`。屏幕不拆 input / output / cache。正常对话只在末尾追加，压缩时整段换成摘要 + 原样留下的尾部。思考块不进请求，文字、图片和工具调用按消息角色转换。
3. **显示：** 接口是 `contextUsage(): { used: number; window: number }`。TUI 还没有，这两个字段先留着，以后底栏读同一处。REPL 每轮结束后打一行 `ctx <used>/<window>`。`/context` 无参数打印同一对数字。
4. **压缩：** 下面几处自动调用同一套切点和摘要，阈值公式参考 Pi。默认 `reserveTokens = 16384`，`keepRecentTokens = 20000`。磁盘 jsonl 保留全文；发给模型的是摘要 + 尾部。本版不接 `/compact`。一轮里最多压一次。
   - 一句 `prompt` 正常结束，且 `used > window - reserveTokens`：压缩，不重试。
   - `stopReason === "error"`，且 `errorMessage` 是上下文满了（“exceeds the context window” / “maximum context length” 这类句子）：丢掉这条报错的 assistant，压缩，再用当前 messages 重跑一轮。只试一次。再满就停，把错误留在屏幕上。
   - `stopReason === "stop"`，且这轮 `usage.input > window`：接口收下了超长输入。压缩，不重试，已经打出来的回复留下。
   - `stopReason === "length"`，且 `usage.output === 0`，并且 `usage.input >= window * 0.99`：输入被截满、没有正文。丢掉这条空 assistant，压缩，再用当前 messages 重跑一轮。只试一次。
   - 重试不再调用 `prompt(text)`，避免多塞一条 user。没有 `usage` 时，后两条不触发。

`/new` 清内存并换新 jsonl 句柄（旧文件留下）。`Agent.reset()` 只清消息，不换文件。

---

## 3. 文件职责与待接通部分

| 文件 | 职责与状态 |
|---|---|
| `src/harness/harness.ts` | 装配、会话管理已接通；窗口 / 估算用量 / 显示已接通，压缩和思考入口待填充 |
| `src/harness/session.ts` | cwd 分桶、jsonl 持久化、命名、列表和恢复；已有 compaction 行读写结构 |
| `src/harness/tools/*`、`src/harness/prompt.ts` | 工具实现与系统提示；图片识别和缩放辅助位于 `tools/image.ts` |
| `src/harness/context.ts` | 已有 `estimateTokens` / `estimateMessagesTokens`；后续承接摘要用量等上下文容量逻辑 |
| `src/harness/compaction.ts` | 已有设置和阈值判断；待实现切点、摘要及压缩流程 |
| `src/cli/utils/image.ts` | 剪贴板读取和图片粘贴按键判断 |
| `src/index.ts` | 导出 Agent、Harness、流式适配和工具等现有入口 |
| `test/probe-harness.ts`、`test/probe-session.ts` | 已有框架与会话探针 |
| `test/probe-context.ts` | 上下文容量阶段计划补充的探针 |

**v1.2 后续接线：**

- `src/cli/main.ts`：`/context` 和每轮后的 `ctx` 显示已接通；剩 `/thinking`。本版不接 `/compact`
- `src/cli/render.ts`：可在 `turn_end` / `agent_end` 打用量（或 main 问 harness 再打印，二选一，不要两处各打一遍）
- `src/agent/agent.ts`：`createLoopConfig` 补上 `reasoning`（同一函数加厚，不另写 stream）
- `src/llm/openai-chat.ts`：请求带 `reasoning_effort`；SSE 解析 `reasoning_content`；能拿到则写入 assistant `usage`
- `src/types.ts`：`StreamOptions.reasoning`；摘要用的可选 `maxTokens`；`Model.contextWindow`；`AssistantMessage.usage?`
- `src/env.ts`：读可选 `OPENAI_CONTEXT_WINDOW`

---

## 4. 分层

```
cli/main.ts + render.ts
   │
   ▼
harness/harness.ts
   ├── harness/tools/*     开局挂上
   ├── harness/prompt.ts
   ├── harness/session.ts   读写 jsonl
   ├── harness/context.ts   窗口 / 用量 / 该不该压
   ├── harness/compaction.ts
   ▼
Agent / loop
   └── llm/openai-chat.ts
```

`env.ts` 仍在 `src/` 根上，读 key / url / model / 可选窗口。不进管家。

---

## 5. 模块说明书

### 5.0 工具与图片输入

工具位于 `src/harness/tools/`，系统提示位于 `src/harness/prompt.ts`，由 `Harness` 装配。`createXxxTool` / `buildSystemPrompt` 是现有入口。

图片粘贴由 CLI 读取剪贴板，沿 `Harness.prompt(text, images?)` → `Agent.prompt(text, images?)` 传递；`read` 返回的图片放在对应的 `ToolResultMessage.content` 中。文本和图片使用内部内容块表示，OpenAI 请求格式由 `openai-chat.ts` 转换。协议所需的附加消息只在构造请求时生成，不作为真实用户输入写回会话；工具来源和图文对应关系需要在转换中保留。

---

### 5.1 `src/harness/harness.ts`

**做什么：** `Harness` 类。开局装配；之后 `main` 只跟它说话。

```ts
export interface HarnessOptions {
  cwd: string;
  apiKey: string;
  model: Model;
  streamFn: StreamFn;
  sessionsRoot?: string; // 默认 ~/.cli-agent/sessions；探针用 tmp
}

export class Harness {
  constructor(options: HarnessOptions);
  readonly agent: Agent; // SIGINT / render 需要 isStreaming、abort、subscribe
  prompt(text: string, images?: ImageContent[]): Promise<void>;
  abort(): void;
  subscribe(listener: ...): () => void;
  newSession(): void;
  listSessions(): { filePath: string; name: string; lastOpenedAt: number }[]; // 按 lastOpenedAt 新到旧
  resumeAt(index: number): boolean; // 1-based，对应 listSessions 的序号；越界或没有则 false
  setThinkingLevel(level: ThinkingLevel): void;
  setContextWindow(tokens: number): void;
  contextUsage(): { used: number; window: number };
  compact(customInstructions?: string): Promise<void>;
}
```

**现有框架：** 构造时创建四个工具、系统提示和 Agent；工具、模型、提示放入 Agent 的 `initialState`。`prompt` / `abort` / `subscribe` 转给 Agent。`newSession` 调 `agent.reset()` 再换会话句柄。`setContextWindow` / `contextUsage` 已接通：`prompt` 结束后用 `estimateMessagesTokens` 更新 `usedTokens`，`newSession` 归零，`resumeAt` 按加载回来的 messages 重算。`setThinkingLevel` / `compact` 已预留并 throw「未接上」，后续在这些入口中接通功能。

**对照：** 角色可参考 Pi 的 `AgentSession`，API 采用本项目设计。extensions、队列和树导航不在当前版本范围；按本次任务需要阅读相关实现。

---

### 5.2 `src/harness/session.ts`

**做什么：** cwd 目录编码、建文件、append、读回 `AgentMessage[]`；会话名和列表也在这里。思考档位不进 jsonl。

- `sessionDirForCwd(cwd, sessionsRoot?): string` → `~/.cli-agent/sessions/--encoded--/`（`sessionsRoot` 默认家目录那份，探针指到 tmp）
- `sessionTitleFromUserText(text): string` → 前 10 个字符，见 §2
- `createSessionFile(...)` 只准备路径和 header（此时 `name` 可空），第一条 assistant 才 `writeFile` header + 已攒的行；flush 前用第一条 user 文本填 `header.name`
- `appendEntry(entry)`
- `loadSession(path): { messages, name }`
- `listSessions(cwd, sessionsRoot?): { filePath, name, lastOpenedAt }[]` 按 mtime 新到旧；`name` 优先 header，缺则从第一条 user 消息现算
- `findMostRecentSession(cwd): string | undefined` 即列表第 1 条的 path
- `touchSession(path)`：更新 mtime（resume 时调用）

当前格式不包含树、lane、`session_info` 或 thinking 档位变更行。compaction / 用量相关行的读写也走这里，类型放在 `session.ts`。`HarnessOptions.sessionsRoot?: string` 默认 `~/.cli-agent/sessions`。

**对照：** `pi/packages/coding-agent/src/core/session-manager.ts` 的 `getDefaultSessionDirPath` 和 `_persist` 中延迟落盘的处理。当前借鉴目录组织和延迟建文件的思路；标题规则、线性格式和恢复交互由本项目确定。

---

### 5.3 上下文容量（`context.ts` + `compaction.ts`）

压缩的前提是：**知道窗口有多大**，以及 **当前用了多少**。这个功能包含窗口、计量、显示和自动压缩，分多个可 review 的小点接通。

**窗口**

- `Model.contextWindow: number`（必填于运行时）。这一版由 `env.ts` 读 `OPENAI_CONTEXT_WINDOW`（正整数，缺省 `128000`）写进这个字段。以后它是配置模型时的一项，环境变量只是现在的填法。
- `/context <n>` 改 `harness.setContextWindow`，写的仍是当前这份 `Model.contextWindow`。不另做厂商目录。

**记录**

- `AssistantMessage` 增加可选 `usage?: { input: number; output: number; totalTokens?: number }`。
- `openai-chat.ts`：SSE / 结束块里若有 `usage` 就写上。没有则 harness 通过现有 `estimateTokens` 估算整段 messages，文字按字符/4，图片按固定开销估。
- 每次 `prompt` 结束后更新 `usedTokens`。session 不必为每一轮单开 usage 行；压缩发生时 `compaction` 行可带 `tokensBefore`。

**显示（CLI，不是网页）**

- 对外只有 `used` 和 `window`。`contextUsage()` 返回这一对。REPL 打 `ctx 12345/128000`，`/context` 无参数打印同一对。启动、`/context <n>` 之后和每轮结束都用同一种形状 `ctx <used>/<window>`，不另打只含窗口的格式。
- 不在屏幕上拆 input、output、cache，也不打距离压缩阈值还剩多少。
- 本版不做进度条、主题色、TUI footer。以后增加 TUI 时复用 `contextUsage()`。

**发给模型的前缀（缓存）**

- 正常对话每轮在末尾追加本轮的 user / assistant / toolResult。已经发过的系统提示、工具列表和更早的消息保持字节不变，以便复用服务端的前缀缓存。
- 流式生成只替换当前这一条还没写完的 assistant。不回头改旧消息的正文，不往系统提示或旧消息里写时间、用量。
- 思考块可以留在本地记录里，当前请求不回传思考；文字、图片和工具调用按消息角色转换。相同历史使用一致的转换方式，避免无关改写影响前缀复用。
- 在当前正常追加与压缩流程中，压缩会整体替换前缀：成功后消息变成「摘要一条 + 切点之后的原文」。留下的尾部逐条原样复制，不改写。这次前缀会变一次，之后再次保持只追加，直到下一次压缩。

**压缩**

- `shouldCompact(used, window, settings)`：`used > window - reserveTokens`。一句 `prompt` 正常结束且为真时压缩，不重试。
- `stopReason === "error"` 且 `errorMessage` 表示上下文满了：丢掉这条报错的 assistant，压缩，再用当前 messages 重跑一轮。只试一次。
- `stopReason === "stop"` 且 `usage.input > window`：压缩，不重试，回复留下。
- `stopReason === "length"` 且 `usage.output === 0` 且 `usage.input >= window * 0.99`：丢掉这条空 assistant，压缩，重跑一轮。只试一次。
- 默认 `enabled: true`，`reserveTokens: 16384`，`keepRecentTokens: 20000`。
- 切点只放在一条 user 之前。从最新往回按字符/4 累加，够 `keepRecentTokens` 就在那条 user 处切开：它前面的整轮进摘要，它和后面的整轮留下。不在 assistant 或 `toolResult` 上切。最新一轮本身已经超过 `keepRecentTokens` 时，这一整轮进摘要，尾巴可以为空。
- 摘要走现有 `streamFn`，不带 tools，不带 reasoning。输出上限为 `floor(0.8 * reserveTokens)`，经 `StreamOptions.maxTokens` 传给请求。已有旧摘要时放进这次输入，并在提示里要求保留。摘要正文开头标明这是压缩出来的上文。
- 摘要调用失败则不改 `agent.state.messages`。成功才写回摘要 + kept，jsonl 追加 `compaction`，并用摘要加尾部重新估计 `usedTokens`。
- 上面几处走同一套切点和摘要。`Harness.compact` 留给这些调用，REPL 不暴露。没有 `usage` 时，`stop` 超窗和空 `length` 两条不触发。

本版范围不包含 `/compact`、分支摘要、文件列表元数据和额外的界面说明文案，也不包含 Pi 的宽 `length` 恢复（有正文，只是输出短于请求上限）。思考能力尚未接通，摘要按普通文本处理。

**对照：** `pi/packages/agent/src/harness/compaction/compaction.ts` 的 `DEFAULT_COMPACTION_SETTINGS`、`shouldCompact`；`pi/packages/ai/src/utils/overflow.ts` 的 `isContextOverflow`：错误文本、`stop` 且 input 超窗、`length` 且输出为 0。当前不接 `isRecoverableLength`；显示和窗口配置采用本项目设计。

---

### 5.4 思考等级

已有 `ThinkingLevel`、`agent.state.thinkingLevel`、loop 的 `thinking_*` 事件。这一版接通。档位是 **Harness 进程状态**，不是 session 字段。

1. `StreamOptions` 增加 `reasoning?: ThinkingLevel`。
2. `Agent.createLoopConfig`：`reasoning: thinkingLevel === "off" ? undefined : thinkingLevel`。
3. `openai-chat.ts`：`reasoning` 存在则 body 加 `reasoning_effort`（字符串就是档位名）。SSE delta 里 `reasoning_content` 或 `reasoning` → `thinking_*` 事件，写入 `ThinkingContent`。
4. `Harness.setThinkingLevel` 只改 `agent.state.thinkingLevel`。不写 jsonl。`/new` `/resume` 都不碰这个字段。
5. `main`：`/thinking` 无参数打印当前档；`/thinking off|minimal|low|medium|high` 调用 set。

本版不扩展 `xhigh`/`max`、thinkingFormat、思考 token budget 或按会话恢复档位。

**对照：** `pi/packages/agent/src/agent.ts` 的 `createLoopConfig`；`pi/packages/ai/src/api/openai-completions.ts` 中设置 `reasoning_effort` 和读取 `reasoning_content` 的处理。优先阅读这些局部，需要时查看调用上下文。

---

### 5.5 `main.ts` 装配

启动：`getOpenAIConfig` + `new Harness({ cwd, apiKey, model, streamFn: streamOpenAIChat })`，`subscribe(renderEvent)`。

循环：普通输入 → `harness.prompt(line, images?)`，剪贴板图片和文字一起提交。`/exit` 退出。`/new` → `newSession`（清消息并换句柄）。整行恰好 `/resume`：打印 `listSessions`（名字 + 本地 `YYYY-MM-DD HH:mm`），再读序号 `resumeAt`。没有则打印一句。不自动加载最近一份。后续把 `/thinking`、`/context` 接到 harness；本版不接 `/compact`。SIGINT：streaming 则 `harness.abort()`。

---

## 6. 接下来如何推进

图片图文关联修复已通过本地验收，主线继续第 3 步上下文容量。以下沿用进度里的步骤编号；已完成工作的过程和验证记录只在进度文档保留。

每行是一个功能里程碑，可以拆成多个小点。每次选几个相关函数和必要接线，说明本次边界，完成对应验证后交给用户 review，再继续。已经存在的基础函数直接接着使用，不因换对话重复搭建。每个代码小点保持 `tsc --noEmit` 通过，功能接通后再做相应行为验收。

| 步 | 做哪些文件 | 完成标准 | 主要对照 |
|---|---|---|---|
| 3 | 上下文容量：`context.ts` + `compaction.ts`；usage；REPL `ctx`；`/context`；阈值压缩；上下文满了压一次并重试 | 能读窗口；每轮有 used；超阈值压成摘要+尾部；报满了或空 `length` 则重试一轮；`stop` 且 input 超窗则压、不重试；jsonl 有 compaction。没有 `/compact` | `shouldCompact`、默认常量；`isContextOverflow` |
| 4 | types + `createLoopConfig` + `openai-chat` + `/thinking` | `/thinking high` 后请求带 `reasoning_effort`；resume 后仍用本进程档位；有 thinking 的模型能打出思考 | agent.ts `reasoning:`；openai-completions 局部 |
| 5 | REPL 按 §7 手测 | §7 清单打勾 | — |

session / 上下文探针只用临时目录，不要往 `src/` 或用户家目录的真实项目会话里写测试数据（probe 可把根目录指到 tmp，或抽 `sessionsRoot` 参数，默认 `~/.cli-agent/sessions`）。

---

## 7. 这一版验收

设好 `OPENAI_API_KEY`。`npm start`。

1. 普通对话 + `read` `package.json` 仍能工作（框架没把工具弄丢）。
2. 说一句话之后，`~/.cli-agent/sessions/--...--/` 下出现 jsonl，里面有 user / assistant；header 的 `name` 是那句话的前 10 个字符。
3. `/new` 后再说一句，同目录多一个文件，两份 `name` 能分开。
4. 退出再启动，整行输入 `/resume` 打印「名字 + 上次打开时间」列表，再输入序号接上那一份（能问「我刚才说了什么」对得上）。
5. 每轮结束后能看到 `ctx used/window`；`/context` 能打印；改 `OPENAI_CONTEXT_WINDOW` 或 `/context <n>` 后窗口跟着变。撑过阈值后，再问模型是摘要+最近消息；jsonl 有 `compaction` 行。模型若返回上下文已满的错误，或空的 `length` 且 input 顶满窗口，会压一次并重试这一轮；再满则停。`stop` 且 `usage.input` 大于窗口时只压缩，不重试。没有 `/compact`。探针覆盖这三种形状。
6. `/thinking medium`（或 high）不报错；`/resume` 之后档位仍是本进程这份，jsonl 里没有 thinking 行。模型若支持 `reasoning_effort`，屏幕上能看到思考或至少请求里带了该字段（probe 可断言 body）。
7. `/new` 后工具还能用，且开始一份新会话。

测完删掉临时 jsonl 和手测写的文件。

---

## 8. Pi 源码阅读入口

按当前小点选择参考文件，无需一次通读整个 Pi。更完整的会话管理、TUI 或其他机制在实际需要时再展开；阅读范围不限制本项目未来的产品能力。参考位置以函数名定位，行号随 Pi 版本变化。

当前相关入口：

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
src/harness/session.ts            目录编码 / jsonl append 的思路；标题自定（10 字，写入 header）
src/harness/context.ts            窗口 / 计量 / 显示（自定）
src/harness/compaction.ts         shouldCompact + 默认阈值
src/harness/tools/*               agent/harness/tools/*，实现按本项目需求调整
src/harness/prompt.ts             本项目的系统提示
createLoopConfig.reasoning        agent.ts 同名补丁
openai-chat reasoning             openai-completions 局部
cli/main.ts                       interactive-mode 的输入循环（readline）
```
