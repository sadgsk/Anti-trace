# CLI Agent 架构书

项目目标是逐步构建一个可开源、可持续使用和演进的产品级个人 CLI agent。开发过程同时服务于用户理解源码：先参考 Pi，从简单到复杂补齐能力，再持续加入自己的设计和想法。学习决定每次推进的大小，产品目标决定框架和功能的设计。

本文只保存**当前有效的设计、实际项目状态和已确定的后续目标**。开发历史、当前版本待办和验收记录见 [progress.md](./progress.md)。新对话先读进度，再根据本文了解设计；不需要从旧版决策中拼出当前规则。

**输入迁移状态（2026-10-12）：**输入迁移功能已完成并提交，旧输入 `stash` 和旧同步 `utils/image.ts` 已删除，已完成的施工计划按用户要求退役。完整草稿、长文本/图片引用、撤销/重做、REPL 命令、Harness 提交和流式显示已接通，`npm start` 可交互对话。此前本机扩展 115 项测试、类型检查和构建通过，包含 macOS 真实 POSIX PTY 与本地 HTTP SSE；扩展测试及辅助脚本按当时要求未提交，`test:input` 只引用仓库现有基础测试。其他平台原生终端、真实剪贴板和具体终端应用仍需手测，见 §7 和进度文档。上下键仅移动当前输入光标，不提供历史召回。

对照代码在 `../pi`（`e:\pi-harness\pi`），下文参考路径从 `pi/` 写起。当前项目独立实现，不依赖 `@earendil-works/pi-*`。

---

## 0. 产品方向与推进方式

### 0.1 框架先确定，实现分小步

- 当前优先补齐已经规划的核心能力，做出能完整运行的 agent。产品级是持续建设的目标；每个版本交付其中一部分，不以练手为由刻意降低实现质量。
- 对已确定的模块职责、数据流和近期功能，能一次搭好的框架就先搭好。接口、类型和函数入口可以先保留，后续沿同一套设计填充，减少因临时方案造成的反复重构。
- 预留入口标明未实现，不把占位当成可用功能。框架先行不等于提前实现全部功能，也不为尚未确定的需求铺设大量兼容分支和兜底。
- 每批必须新增或完善一个主流程函数，交付清楚的输入、处理步骤和输出；期间更新的功能函数、必要类型和接线不计数量，不再按函数总数拆批。每批改之前先说明主流程函数和配套改动，写完等用户 review 再继续。版本目标可以跨多批完成；例如上下文容量是一个版本目标，不要求一次写完窗口、计量、显示和压缩。
- 每个功能点尽量直接采用整个功能完成后仍会保留的结构和行为，避免为当前小批临时能跑而加入过渡类型、临时接线、假实现或短期分支，后续再大改。依赖紧密、难以独立完成时扩大本批范围，合并相关步骤，一次完成一个完整功能后再 review；不要为了拆小步制造后续需要推倒的实现。
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

### 0.4 源码讲解方式

**适用前提：只有用户明确要求逐行解释某个函数时，才启用本节标准，并仅用于当次指定的函数。其他情况下忽略本节格式，按当前问题直接说明概念、逻辑或作用。**

启用后，用简短、准确的自然语言翻译代码实际发生的事情，帮助用户建立代码与功能的对应关系，围绕用户指定的函数讲解。

- 保留原代码，按执行顺序拆成小段；每条有实际含义的代码行单独展示，对应解释紧跟在该行下方，保持一一对应。闭合括号可以保留，无需逐个解释符号。
- 每行直接说它做了什么：定义函数时说明参数分别代表什么；定义变量时说明保存什么、初值是什么；判断时说明检查哪个变量的哪些条件、满足后发生什么；赋值时说明哪个状态变成什么；调用函数时说明传入什么、被调用函数会完成什么操作。
- 语法说明只保留理解当前动作所需的内容，例如“定义函数”“定义箭头函数”“准备一个数组”。无需把每行拆成“语法 / 功能”两套说明，也不逐个展开 `new`、运算符或标点；用户专门问语法时再展开。
- 每个逻辑段讲完后，用一小段话说明这部分完成了什么、在整个功能中起什么作用，把逐行动作连成流程。
- 参数、下标或计算容易混淆时，用短输入和具体数字演示：先算出实际传入的值，再说明它成为哪个参数，以及调用后哪些状态发生变化。涉及位置时说清它属于原文下标还是显示列。
- 边界说明围绕当前代码的实际条件和结果。发现设计冲突或代码问题时，仍按 §0.1 当场说明，并区分代码推导和实测；段末以用途说明收束，不追加与当前代码语义无关的假设风险提示。

例如，讲解处理换行的两句调用时，采用下面的排版：

```ts
finishLine();
```
保存换行符前面的当前行。

```ts
startLine(index + segment.length);
```
把换行符之后的原文下标传给 `startLine`，从这个位置初始化新行。

这一段先收好上一行，再准备下一行，让后续字素从新行继续加入。参考来源和本项目取舍仍按 §0.2 说明。

---

## 1. 现在有什么 / 这一版做什么

| 能力 | 当前状态 |
|---|---|
| 对话与工具 | Harness、多轮对话、`read` / `write` / `edit` / `bash`、流式和 abort 已接入新 REPL；交互入口已恢复 |
| 装配与会话 | 工具和系统提示在 `src/harness/`；`Harness` 装配 Agent，按 cwd 保存 jsonl；新 REPL 已接回 `/new`、`/resume` 列表与序号选择 |
| 终端输入 | 输入迁移已完成；唯一 stdin 宿主、协议解析、焦点分发、多行字素编辑、粘贴合并、完整附件草稿、撤销/重做和提交展开已接通；非 TTY 在 EOF 提交一次原文 |
| 图片输入 | `read` 与输入支持 jpeg/png/gif/webp；异步图片路径/剪贴板读取交给完整草稿，输入中显示可删除/撤销的引用，提交时发送真实图片内容 |
| 协议适配 | 当前只实现 OpenAI Chat Completions，用于运行和测试；消息转换在 `openai-chat.ts`，内部保留内容块结构；含图工具结果在整批 tool 回复后按来源分组、保留图文顺序发送，已通过本地请求体验收 |
| 上下文容量 | 窗口、用量、摘要、自动压缩及手动 `/compact` 已接回新 REPL，`/context` 与每轮 `ctx` 显示可用；本地 HTTP 摘要与续聊验证通过。默认窗口 `256000`，用量优先取接口 `usage`；真实模型压缩验收暂缓 |
| 思考等级与 BYOK | 尚未接到请求与 CLI；已整理 [BYOK build](./byok-build.md)，固定五档与独立开关，参考新版 TS Kimi Code 与 CC Switch，按小批次实施 |

**这一版（v1.2）的既定目标：**

1. 把工具和系统提示收进 `src/harness/`，`main` 不再 `createXxxTool` / `new Agent`。
2. `Harness`：开局装配；`prompt` 交给 Agent；每轮收尾。
3. 按 cwd 把对话写成 jsonl（一个项目多份聊天）。会话名从第一条用户消息截出来，不另跑模型起名；`/resume` 用「名字 + 上次打开时间」分辨。
4. **上下文容量**：窗口设置、用量记录、REPL 显示、自动压缩与溢出重试；手动 `/compact` 在用量超过窗口 1/4 时可用。
5. 思考等级与 BYOK 作为一项功能设计和实现：用户配置模型连接，使用固定五档与独立思考开关，适配器按模型／接口规则处理；支持 OpenAI Chat Completions、Anthropic Messages 和 OpenAI Responses 的基础对话与工具调用。

图片文件和剪贴板读取已通过新输入接入完整草稿；提交时按有效引用收集真实图片内容。

**后续范围：** v1.3 做 TUI。v1.2 先以三种协议的基础接入和固定五档／独立开关为目标，模型与接口规则及施工边界见 BYOK build；具体实现细节在各批确定。Windows bash 问题（No.1）单独安排。会话继续使用线性 JSONL，不做会话树、`/tree`、树状 fork 或 Pi v4 session 迁移，也不引入 SQLite。v1.1 遗留手测继续在进度里记录，不阻塞 v1.2 开发。

---

## 2. v1.2 目标行为

下面的会话、命令和上下文行为已接入新 REPL；思考等级与 BYOK 按 build 文档等待分批实现。输入链路的当前职责见 §3，验证范围见 §7。

```text
main（屏幕）
  输入组件：多行草稿、/exit /new /resume /context /compact
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
        └── 协议适配器（Chat Completions / Anthropic Messages / OpenAI Responses）
```

新 REPL 从输入组件接收完整草稿、展开引用、处理斜杠命令、订阅事件并处理中断；不创建工具，不 `new Agent`。`main.ts` 装配 Harness 并选择 TTY 交互或非 TTY EOF 提交。交互输出统一经 Ink，非 TTY 增量写回复；终端事件、编辑和提交各自分层。

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
- `/resume`：打印列表，再通过同一输入组件读取序号，调用 `resumeAt`。空行取消，不加载。
- 只有整行恰好是 `/resume` 才进这条命令；`/resume 2` 这类不算。
- 没有可 resume 的文件则打印一句，不 throw。不自动打开最近一份。

jsonl 首行 header，之后每行一条，使用线性 append，不包含 `parentId` 树：

```json
{"type":"session","version":1,"id":"...","timestamp":"...","cwd":"...","name":"帮我改一下"}
{"type":"message","message":{...AgentMessage}}
{"type":"compaction","summary":"...","keptMessages":[...]}
```

**思考等级现状：** `agent.state.thinkingLevel` 已有默认 `off` 的占位状态，`setThinkingLevel` 尚未接通；当前 jsonl 没有思考档位变更行。最终可选档位、模型切换及恢复行为随 BYOK 一起设计，不以这个占位状态作为最终方案。

**上下文容量**先有窗口和用量。压缩在用量过线，或这轮回复表明上下文装不下时自动发生。

1. **窗口：** 数字在 `Model.contextWindow`。当前用 `.env` 的 `OPENAI_CONTEXT_WINDOW` 填进去，缺省 `256000`，无效值回退缺省。BYOK 接通后窗口跟模型配置走。`/context <正整数>` 只改本进程这份 `Model.contextWindow`。
2. **记录：** 优先用 `AssistantMessage.usage` 中接口返回的用量；没有则用现有 `estimateTokens` 估算，文字按字符/4、图片按固定开销估。Harness 记住当前 `usedTokens`。屏幕不拆 input / output / cache。正常对话只在末尾追加，压缩时整段换成摘要 + 原样留下的尾部。当前适配器不回传思考块；文字、图片和工具调用按消息角色转换，后续思考内容回传随 BYOK 一起设计。
3. **显示：** 接口是 `contextUsage(): { used: number; window: number }`。TUI 还没有，这两个字段先留着，以后底栏读同一处。REPL 每轮结束后打一行 `ctx <used>/<window>`。`/context` 无参数打印同一对数字。
4. **压缩：** 自动路径已调用同一套切点和摘要，阈值公式参考 Pi。默认 `reserveTokens = 16384`，`keepRecentTokens = 20000`。磁盘 jsonl 保留全文；发给模型的是摘要 + 尾部。一轮里最多自动压一次。手动 `/compact` 仅在 `used > window / 4` 时尝试同一套压缩；没有可压旧历史或刚压完没有新消息时明确提示。
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
| `src/harness/harness.ts` | 装配、会话、窗口、用量、自动/手动压缩已接通；本轮补齐 prompt 全程和摘要取消，中断摘要不改历史；思考入口待接 |
| `src/harness/session.ts` | cwd 分桶、jsonl 持久化、命名、列表和恢复；已有 compaction 行读写结构 |
| `src/harness/tools/*`、`src/harness/prompt.ts` | 工具实现与系统提示；图片识别和缩放辅助位于 `tools/image.ts` |
| `src/harness/context.ts` | 已有 `estimateTokens` / `estimateMessagesTokens`；后续承接摘要用量等上下文容量逻辑 |
| `src/harness/compaction.ts` | 阈值、溢出判断、切点、摘要与包装；本地 HTTP 摘要/持久化/续聊已验证，真实模型验收暂缓 |
| `src/cli/ink/terminal-host.ts`、`terminal-input.ts` | 第 1–2 批宿主与解析：真实 stdin 的唯一读取者，管理 raw mode 和 bracketed paste，并将字节解析为终端事件；Ink 只负责渲染 |
| `src/cli/input/keybindings.ts`、`input-dispatcher.ts` | 快捷键纯解析、默认编辑/撤销/图片映射、REPL 退出覆盖与焦点分发；已接入真实组件和运行入口 |
| `src/cli/input/text-input-state.ts`、`text-input-layout.ts` | 第 4 批完成：纯字素编辑及共享显示行列映射，供上下移动和基础组件渲染共用；保留原文 |
| `src/cli/input/text-input-controller.ts`、`use-text-input.ts`、`base-text-input.tsx`、`terminal-text-input.tsx` | 同步动作、Enter/换行、精确编辑范围、上层引用变换与 React 重画；基础适配器可独立运行，正式 REPL 复用控制器和组件 |
| `src/cli/input/paste-handler.ts`、`src/cli/utils/image-paste.ts` | 100 ms 粘贴合并、同步 pending、按序交付文本/图片、异步读取及停止/换草稿清理；图片交给完整草稿层 |
| `src/cli/input/prompt-draft.ts` | 文字、光标、可信引用范围与附件同属不可变草稿；`preparePromptSubmission()` 展开原文并收集图片 |
| `src/cli/input/prompt-input-controller.ts`、`prompt-input.tsx` | 长文本/图片占位、原子移动与删除、完整草稿撤销/重做、提交门槛与输入显示 |
| `src/cli/repl/repl-controller.ts`、`terminal-repl.tsx` | 命令/会话选择、同步 busy 门槛、Harness 事件投影、唯一终端宿主装配、Ink 显示与退出清理 |
| `src/cli/main.ts` | `runCli()` 装配 Harness，TTY 交互和非 TTY EOF 提交共用 REPL 逻辑；导入不启动进程 |
| `docs/byok-build.md` | 思考等级与 BYOK 的功能分工、Kimi Code／CC Switch 参考入口及可调整的小批次路线 |
| `src/index.ts` | 导出 Agent、Harness、流式适配和工具等现有入口 |
| `test/probe-harness.ts`、`test/probe-session.ts` | 已有框架与会话探针 |
| `test/probe-context.ts` | 历史本地假流探针曾覆盖压缩与重试；当前工作区无该文件，不能作为可运行命令 |
| 仓库已有的基础输入测试 | `test:input` 覆盖编辑、布局、组件、粘贴和图片读取；本轮完整草稿/REPL/本地 HTTP/PTY 扩展用例只保留在本机，不提交 |

**v1.2 后续：** 新输入及 `/new`、`/resume`、`/context`、`/compact`、每轮 `ctx` 已接回。思考等级与 BYOK 按 build 文档分批实施；保留 Agent / Harness 的消息和事件边界。

---

## 4. 分层

```
输入层（宿主 → 分发 → 文本编辑 → 完整草稿；职责见 §3）
   │ 提交草稿快照
   ▼
cli/main.ts + cli/repl/*（展开引用、命令与 Harness 事件；Ink 统一交互输出）
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

新输入异步读取图片文件/剪贴板，经回调把真实图片内容交给 `PromptInputController`，草稿显示 `[Image #N]`。提交时只收集仍被引用的图片，沿 `Harness.prompt(text, images?)` → `Agent.prompt(text, images?)` 传递；`read` 的图片放在对应的 `ToolResultMessage.content` 中。图片不进入文本粘贴 `chunks`。OpenAI 格式由 `openai-chat.ts` 转换；协议附加消息只在构造请求时生成，不作为真实用户输入写回会话，工具来源和图文顺序保留。

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
  manualCompact(): Promise<"compacted" | "below-threshold" | "nothing-to-compact">;
  compact(customInstructions?: string): Promise<boolean>; // 已实现；false 表示没有可压的旧历史
}
```

**现有框架：** 构造时创建四个工具、系统提示和 Agent；工具、模型、提示放入 Agent 的 `initialState`。`prompt` / `abort` / `subscribe` 转给 Agent。`newSession` 调 `agent.reset()` 再换会话句柄。`prompt` 优先用接口 usage 更新 `usedTokens`，取不到则估算；自动压缩与 `compact()` 已接通，`resumeAt` 按加载的 messages 重算。`manualCompact()` 只检查手动用量门槛和压后是否有新消息，再调用同一个 `compact()`。`setThinkingLevel` 仍是占位。

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

- `Model.contextWindow: number`（必填于运行时）。当前由 `env.ts` 读 `OPENAI_CONTEXT_WINDOW`（正整数，缺省 `256000`）写入；BYOK 接通后由用户配置的模型提供。
- `/context <n>` 改 `harness.setContextWindow`，写的仍是当前这份 `Model.contextWindow`。模型能力信息来源随思考等级与 BYOK 一起确定。

**记录**

- `AssistantMessage` 增加可选 `usage?: { input: number; output: number; totalTokens?: number }`。
- `openai-chat.ts`：请求带 `stream_options: { include_usage: true }`；流末尾的 usage 块 `choices` 为空，解析要在 `choice` 判断之前读走并写进 assistant。字段映射只改名：`prompt_tokens` → `input`、`completion_tokens` → `output`；`input` 不减缓存命中（缓存 token 同样占窗口，本版也不拆 cache）。网关不发 usage 时不写这个字段。
- 用量取最后一条 assistant 的 `input + output`（下次请求要重发的量）。取不到则 harness 通过现有 `estimateTokens` 估算整段 messages，文字按字符/4，图片按固定开销估。
- 每次 `prompt` 结束后更新 `usedTokens`。session 不必为每一轮单开 usage 行；压缩发生时 `compaction` 行可带 `tokensBefore`。

**显示（CLI，不是网页）**

- 对外只有 `used` 和 `window`。`contextUsage()` 返回这一对。REPL 例如打 `ctx 12345/256000`，`/context` 无参数打印同一对。启动、`/context <n>` 之后和每轮结束都用同一种形状 `ctx <used>/<window>`，不另打只含窗口的格式。
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
- 切点只放在一条 user 之前。从最新往回按字符/4 累加，够 `keepRecentTokens` 就在那条 user 处切开：它前面的整轮进摘要，它和后面的整轮留下。不在 assistant 或 `toolResult` 上切。最新一轮本身超过 `keepRecentTokens` 时仍从这一轮开始保留；若它就是唯一一轮，则没有可压缩的旧历史。
- 摘要走现有 `streamFn`，原样发送完整上下文和 tools，在末尾加摘要指令以复用前缀缓存；若模型返回工具调用，忽略该次回复并重试，不执行工具。当前摘要请求不带 reasoning。输出上限为 `floor(0.8 * reserveTokens)`，经 `StreamOptions.maxTokens` 传给请求。已有旧摘要时放进这次输入，并在提示里要求保留。摘要正文开头标明这是压缩出来的上文。
- 摘要调用失败则不改 `agent.state.messages`。成功才写回摘要 + kept，jsonl 追加 `compaction`，并用摘要加尾部重新估计 `usedTokens`。
- 上面几处走同一套切点和摘要。自动路径直接调用 `Harness.compact()`；REPL `/compact` 通过 `manualCompact()` 判断 `used > window / 4` 后复用它。没有 `usage` 时，`stop` 超窗和空 `length` 两条不触发。

手动 `/compact` 只在用量过 1/4 时运行现有摘要，不单独设置短会话切点；无旧历史或刚压完没有新消息时提示。成功后 jsonl 追加 `compaction`，内存换成摘要 + 保留的尾部，下一条输入从这里继续；摘要失败不换历史。分支摘要、文件列表元数据和 Pi 的宽 `length` 恢复（有正文，只是输出短于请求上限）不在本版。当前思考能力尚未接通，摘要按普通文本处理。

**对照：** `pi/packages/agent/src/harness/compaction/compaction.ts` 的 `DEFAULT_COMPACTION_SETTINGS`、`shouldCompact`；`pi/packages/ai/src/utils/overflow.ts` 的 `isContextOverflow`：错误文本、`stop` 且 input 超窗、`length` 且输出为 0。当前不接 `isRecoverableLength`；显示和窗口配置采用本项目设计。

---

### 5.4 思考等级与 BYOK（已整理 build 路线，尚未实现）

完整产品行为、源码参考、功能分工和小批次路线见 [BYOK build](./byok-build.md)。当前 `ThinkingLevel`、`agent.state.thinkingLevel`、`thinking_*` 事件与 `setThinkingLevel` 仍是未接通的旧占位，不能标为功能完成。

已确定对外固定 `low / medium / high / xhigh / max` 和独立思考开关。档位较少按原生强度顺序映射并重复最高档；仅开关模型五档全部映射为开启；预算模式直接查五档预算表。主页不隐藏／禁用档位，也不提示“仅支持开关”。关闭不映射成低档，不发送参数也不等于关闭；不能真实关闭或请求不合法时正常报错。

Agent / Harness 使用统一适配器入口。内部集中处理模型规则、思考映射、接口兼容、消息与工具组装、流式响应及必要思考回传信息；用小函数和规则表组织，不给上层增加多层 ThinkingResolver／Router 服务。三种主协议仍为 OpenAI Chat Completions、OpenAI Responses、Anthropic Messages；厂商引用共用协议和兼容模板，同格式新厂商通常只增加连接／规则数据，不增加 controller 分类。

参考新版 TypeScript `../kimi-code` 的统一请求边界和 base／trait 复用，结合 CC Switch 的模型映射、预算与字段兼容部分。一手 LLM 厂商优先，不整批搬入套餐网关预设，也不照搬 Kimi 的完整 DI／注册系统。规则以模型、当前接口和协议为边界，允许用户明确覆盖；未知接口不能假定支持所有 effort。

模型、开关与档位按轮次快照，工具续接沿用本轮设置；普通请求与压缩共用凭据和适配器。消息保存必要签名／opaque reasoning 及来源，恢复兼容旧 JSONL；不同模型／接口的签名不混发。具体配置字段、预算数值、辅助函数与验证细节在小批次中根据代码确定，写完停下 review，不一次实施整份文档。

---

### 5.5 `main.ts` 装配

启动：`runCli()` 读取 `getOpenAIConfig` 并装配 `new Harness({ cwd, apiKey, model, streamFn: streamOpenAIChat })`。TTY 进入 `startTerminalRepl()`；非 TTY 收集原始 UTF-8 输入到 EOF，再交给同一个 `ReplController`。

`npm start` 已恢复交互：输入完整草稿展开后调用 Harness，命令包括 `/new`、`/resume`、`/context`、`/compact`、`/help` 和 `/exit`。接受提交后清理整份草稿；生成时允许编辑下一条但不提前提交。Agent 事件由 REPL 投影到 Ink，不同时订阅直接写 stdout 的 `renderEvent`。退出、EOF、信号、回调异常统一清理订阅和终端模式；非 TTY 只打印模型/命令输出，退出码反映错误或信号。

---

## 6. 接下来如何推进

第 3 步上下文容量与第 5 步手动入口的代码和假 `StreamFn` 探针已完成，真实模型的压缩验收暂缓。原第 4 步思考等级与第 6 步 BYOK 的合并路线已整理为 [BYOK build](./byok-build.md)，按用户选择的小批次推进并逐批 review；功能尚未开始实现。v1.3 才做完整 TUI。历史记录仍沿用原步骤编号。

每行是一个功能里程碑，可以拆成多个小点。每次选几个相关函数和必要接线，说明本次边界，完成对应验证后交给用户 review，再继续。已经存在的基础函数直接接着使用，不因换对话重复搭建。每个代码小点保持 `tsc --noEmit` 通过，功能接通后再做相应行为验收。

| 步 | 做哪些文件 | 完成标准 | 主要对照 |
|---|---|---|---|
| 3 | 上下文容量：窗口、usage、显示、自动压缩和溢出重试 | 代码与假 `StreamFn` 验证已完成；真实模型压缩验收待做 | `shouldCompact`；`isContextOverflow` |
| 5 | 手动 `/compact` + 1/4 用量门槛 | 入口代码与假流验证完成；未过线不调模型，过线且有旧历史则生成摘要并落 `compaction`；待 review 和真实模型续聊验收 | 当前 `Harness.compact()`；`findCutIndex` |
| 4+6 | 思考等级与 BYOK：按 build 路线补模型连接、三协议、固定五档／开关、接口兼容与回传 | 配置模型完成多轮工具调用；用户选择按规则生效，关闭不伪装为低档；会话与压缩沿用正确配置 | 新版 TS Kimi Code、CC Switch 对应映射／兼容模块、官方接口文档 |
| 7 | REPL 按 §7 验收 | 功能验证完成并记录未覆盖的网关差异 | — |

session / 上下文探针只用临时目录，不要往 `src/` 或用户家目录的真实项目会话里写测试数据（probe 可把根目录指到 tmp，或抽 `sessionsRoot` 参数，默认 `~/.cli-agent/sessions`）。

---

## 7. 这一版验收

新 REPL 已接通，本机 115 项扩展输入测试通过，包括 macOS 真实 POSIX PTY、实际 Harness 与本地 HTTP SSE；扩展文件按用户要求不提交，仓库脚本只运行已有基础测试。下列清单仍包含真实模型、特定终端应用及尚未实现的思考/BYOK 验收，不能以本地测试替代。自动压缩与溢出形状由可控流探针验证；手动压缩只有在 `used > window / 4` 且存在可压旧历史时才发起摘要请求。默认窗口 `256000` 的手动门槛是 `64000`。

1. 普通对话 + `read` `package.json` 仍能工作（框架没把工具弄丢）。
2. 说一句话之后，`~/.cli-agent/sessions/--...--/` 下出现 jsonl，里面有 user / assistant；header 的 `name` 是那句话的前 10 个字符。
3. `/new` 后再说一句，同目录多一个文件，两份 `name` 能分开。
4. 退出再启动，整行输入 `/resume` 打印「名字 + 上次打开时间」列表，再输入序号接上那一份（能问「我刚才说了什么」对得上）。
5. 每轮结束后能看到 `ctx used/window`；`/context` 能打印；改窗口配置或 `/context <n>` 后窗口跟着变。假流探针覆盖阈值压缩、溢出报错、空 `length` 重试和 `stop` 超窗只压。`/compact` 在用量未过 1/4 时提示无需压缩；过线且有可压旧历史时用真实模型生成摘要，jsonl 有 `compaction` 行，续聊能利用摘要和保留的尾部。
6. 按最终确定的模型配置检查思考选项：能控制的档位与实际请求一致；不能控制或参数被拒绝时有明确反馈，兜底与重试行为可复现。模型切换和会话恢复的预期行为在合并设计时确定。
7. 分别选择 OpenAI Chat Completions、Anthropic Messages、OpenAI Responses，使用自填 URL / key / 模型完成多轮文本、一次工具调用及结果回传；核对 usage、错误、中断和不支持图片时的明确提示。
8. `/new` 后工具还能用，且开始一份新会话。
9. 验收实际终端中的多行粘贴、独立 Enter、组合键、图片引用和 `/resume` 序号输入。Windows PowerShell、WebStorm 终端和 macOS Terminal 的手动结果分别记录，不能以单个平台的探针代替。

测完删掉临时 jsonl 和手测写的文件。

**公开试用评估：** v1.2 功能清单做完后，可以作为早期 CLI 试用版公开，不必等 v1.3 TUI；但发布前至少要让三种协议的端到端验收可复现，把关键探针纳入仓库，并处理已知会影响正常使用的中断后工具配对、Windows bash 卡住和可恢复溢出错误提前显示问题。README 需要写清安装、配置示例、各协议能力与限制，以及工具会读写文件和执行命令；仓库还需明确许可证。以上是发布门槛，不表示这些问题当前已经解决。

---

## 8. Pi 源码阅读入口

按当前小点选择参考文件，无需一次通读整个 Pi。更完整的会话管理、TUI 或其他机制在实际需要时再展开；阅读范围不限制本项目未来的产品能力。参考位置以函数名定位，行号随 Pi 版本变化。

当前相关入口：

1. `session-manager.ts`：`getDefaultSessionDirPath`、`_persist` 延迟建文件
2. `harness/compaction/compaction.ts`：默认常量和 `shouldCompact`
3. 思考等级与 BYOK 按 [build 文档](./byok-build.md) 选择新版 TS Kimi Code、CC Switch 的具体入口；Pi 的模型能力和协议处理作为补充参考
4. 仓库里现有的 `src/agent/agent.ts`、`src/llm/openai-chat.ts`、`src/cli/main.ts`

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
思考等级与 BYOK                    模型能力、协议适配和可配置映射，待合并设计
cli/input/*                       新输入、完整附件草稿与撤销；参考 CC 输入链路
cli/repl/*                        提交展开、命令分派、Harness 事件与 Ink 显示
cli/main.ts                       Harness 装配；TTY 交互 / 非 TTY EOF 提交
```
