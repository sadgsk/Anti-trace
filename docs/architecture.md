# CLI Agent 架构书

项目目标是逐步构建一个可开源、可持续使用和演进的产品级个人 CLI agent。开发过程同时服务于用户理解源码：先参考 Pi，从简单到复杂补齐能力，再持续加入自己的设计和想法。学习决定每次推进的大小，产品目标决定框架和功能的设计。

**长期产品目标（2026-10-21 明确，尚未实现）：** agent 根据用户的一句话描述，动态修改自身 CLI 的功能，范围包括工具、CLI 界面等，并通过热启动应用变更。需求解析、变更实施、验证及热启动机制仍待设计和实现；现有 `/reload` 仅重载模型配置，不能据此视为已经具备该能力。对外说明和预计架构图见 [中文 README](../README.md) / [English README](../README.en.md)。

本文只保存**当前有效的设计、实际项目状态和已确定的后续目标**。开发历史、当前版本待办和验收记录见 [progress.md](./progress.md)。新对话先读进度，再根据本文了解设计；不需要从旧版决策中拼出当前规则。

**输入迁移状态（2026-10-15）：**输入迁移功能已完成并提交，旧输入 `stash` 和旧同步 `utils/image.ts` 已删除，已完成的施工计划按用户要求退役。完整草稿、长文本/图片引用、撤销/重做、REPL 命令、Harness 提交和流式显示已接通，`npm start` 可交互对话。此前本机扩展 115 项测试、类型检查和构建通过，包含 macOS 真实 POSIX PTY 与本地 HTTP SSE。现按用户要求，整个 `test/` 均仅保留在本地，取消历史文件跟踪和 npm 测试／探针入口，后续另建测试框架。其他平台原生终端、真实剪贴板和具体终端应用仍需手测，见 §7 和进度文档。上下键仅移动当前输入光标，不提供历史召回。

对照代码在 `../pi`（`e:\pi-harness\pi`），下文参考路径从 `pi/` 写起。当前项目独立实现，不依赖 `@earendil-works/pi-*`。

---

## 0. 产品方向与推进方式

### 0.1 框架先确定，实现分小步

- 当前优先补齐已经规划的核心能力，做出能完整运行的 agent。产品级是持续建设的目标；每个版本交付其中一部分，不以练手为由刻意降低实现质量。
- 对已确定的模块职责、数据流和近期功能，能一次搭好的框架就先搭好。接口、类型和函数入口可以先保留，后续沿同一套设计填充，减少因临时方案造成的反复重构。
- 预留入口标明未实现，不把占位当成可用功能。框架先行不等于提前实现全部功能，也不为尚未确定的需求铺设大量兼容分支和兜底。
- 每批必须新增或完善一个主流程函数，交付清楚的输入、处理步骤和输出；期间更新的功能函数、必要类型和接线不计数量，不再按函数总数拆批。每批改之前先说明主流程函数和配套改动，写完等用户 review 再继续。版本目标可以跨多批完成；例如上下文容量是一个版本目标，不要求一次写完窗口、计量、显示和压缩。
- 每个功能点尽量直接采用整个功能完成后仍会保留的结构和行为，避免为当前小批临时能跑而加入过渡类型、临时接线、假实现或短期分支，后续再大改。依赖紧密、难以独立完成时扩大本批范围，合并相关步骤，一次完成一个完整功能后再 review；不要为了拆小步制造后续需要推倒的实现。
- 文件中的已知职责应尽量一次按最终结构完成。若必须保留以后确定会替换的代码，动手前说明依赖，在代码原处注明阶段性原因、替换条件／批次，并在交付中列具体位置；仅在规划文档写待办不够。新增能力与替换已有逻辑分别说明，不为“以后可能共用”主动制造重构。
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

**配置错误处理约定（必须遵守）：** Harness 的创建和会话生命周期必须独立于模型配置。没有配置、配置损坏或请求失败，都不能阻止 Harness 启动或让交互 CLI 退出；`/new`、`/resume`、查看上下文等不依赖模型的功能必须照常可用。模型缺失以 `undefined` 表达，不使用假模型或空 key 凑出启动条件。只有聊天、压缩等依赖模型的操作在内部检查模型／凭据，缺失时中止该操作，提示原因及修正入口；应在写入消息、保存图片等副作用前拦截。

配置加载／应用边界校验 JSON、schema、引用、地址和参数约束；以后增加保存入口时，须先校验候选，失败不写盘。校验失败保留上一次生效配置和会话，没有可用配置时仍保持 Harness 可用。凭据解析、协议支持与请求编码在需要模型时处理，不能扩大成启动门禁；HTTP／流内错误沿请求错误事件显示并回到输入状态。底层可用 `ByokConfigError` 中止无效操作，由配置边界或 REPL 转为诊断，不交给顶层退出分支。不得自动探测远端接口，不回显凭据或原始配置，不擅自回退模型。管道同样先识别操作：会话命令不因模型配置错误失败，依赖模型的操作失败才返回非零。必须验证“无配置仍能恢复会话、修正后在原会话继续、坏候选保留旧配置、请求失败后仍可操作”，不能只测是否抛错。参见 [No.5 修复记录](./review-records.md#no5--模型配置问题会导致-cli-直接退出)。

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
| 协议适配 | 上层使用 streamModel；已实现 Chat、Responses、Anthropic 的请求、思考、工具与图文转换。SSE 处理分块、usage、错误与取消，缺少结束原因时报错 |
| 上下文容量 | 窗口、用量、摘要、自动压缩及手动 `/compact` 已接回新 REPL，`/context` 与每轮 `ctx` 显示可用；本地 HTTP 摘要与续聊验证通过。窗口由 BYOK 模型配置提供，用量优先取接口 `usage`；真实模型压缩验收暂缓 |
| 思考等级与 BYOK | 三协议、统一设置、逐请求凭据、压缩、会话选择恢复和思考显示均已接通；九家厂商有限绑定与 36 个连接预设已完成，既有 review 尾项保留 |

**这一版（v1.2）的既定目标：**

1. 把工具和系统提示收进 `src/harness/`，`main` 不再 `createXxxTool` / `new Agent`。
2. `Harness`：开局装配；`prompt` 交给 Agent；每轮收尾。
3. 按 cwd 把对话写成 jsonl（一个项目多份聊天）。会话名从第一条用户消息截出来，不另跑模型起名；`/resume` 用「名字 + 上次打开时间」分辨。
4. **上下文容量**：窗口设置、用量记录、REPL 显示、自动压缩与溢出重试；手动 `/compact` 在用量超过窗口 1/4 时可用。
5. 思考等级与 BYOK 作为一项功能设计和实现：用户配置模型连接，使用固定五档与独立思考开关，适配器按模型／接口规则处理；支持 OpenAI Chat Completions、Anthropic Messages 和 OpenAI Responses 的基础对话与工具调用。

图片文件和剪贴板读取已通过新输入接入完整草稿；提交时按有效引用收集真实图片内容。

**后续范围：** v1.3 做 TUI。v1.2 的三协议、固定五档／独立开关和厂商适配已完成，后续按实际需要补模型绑定与真实接口验证。Windows bash 问题（No.1）单独安排。会话继续使用线性 JSONL，不做会话树、`/tree`、树状 fork 或 Pi v4 session 迁移，也不引入 SQLite。v1.1 遗留手测继续在进度里记录，不阻塞 v1.2 开发。

---

## 2. v1.2 目标行为

下面的会话、命令和上下文行为已接入新 REPL；BYOK 已实现三协议与统一设置链，配置入口见 [厂商示例](../byok.providers.example.json)，验证范围见 [开发进度](./progress.md)。输入链路的当前职责见 §3，验证范围见 §7。

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

新 REPL 从输入组件接收完整草稿、展开引用、处理斜杠命令、订阅事件并处理中断；不创建工具，不 `new Agent`。`main.ts` 先装配 Harness，再尝试加载配置，最后选择 TTY 交互或非 TTY EOF 提交。`ByokRuntime.reload()` 只负责候选配置的加载、校验与应用；通过 main 注入的回调调用现有 `Harness.configureModel()`，不持有或创建 Harness。无配置时 Agent 的 model 为 `undefined`，工具、消息和会话管理照常工作；具体模型操作内部检查配置。`/reload` 重试最近的路径与选择，`/config [路径]` 查看状态或更换文件，`/model <模型键>` 选择本次运行的模型；失败候选与当前生效配置分别保存，设置成功应用后才提交配置状态。重载不重建 Harness、Agent、会话或订阅。交互输出统一经 Ink，非 TTY 增量写回复；终端事件、编辑和提交各自分层。

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
{"type":"settings","modelRef":{"configPath":".../byok.json","modelKey":"main"},"thinking":{"effort":"high","enabled":true}}
{"type":"message","message":{...AgentMessage}}
{"type":"compaction","summary":"...","keptMessages":[...]}
```

**思考等级现状：** `agent.state.thinking` 保存 `{ enabled?, effort }`，档位固定为 `low / medium / high / xhigh / max`。初始档位 medium，开关未指定表示服务端默认；关闭仍保存档位。`createLoopConfig()` 复制模型（含 adapter 规则）与偏好，loop 传到统一 StreamFn；三协议已按规则完成真实编码与思考解析。Harness 提供 setThinkingLevel / setThinkingEnabled；CLI 提供 /thinking、/effort 和独立 /thinking-display。JSONL settings 保存模型目录引用与偏好；/new 继承，/resume 恢复，缺引用保留历史并提示当前模型。

**上下文容量**先有窗口和用量。压缩在用量过线，或这轮回复表明上下文装不下时自动发生。

1. **窗口：** 数字在 `Model.contextWindow`，由 BYOK JSON 中当前模型的 `contextWindow` 提供正整数，缺失或无效时报配置错误。`/context <正整数>` 只改本进程这份 `Model.contextWindow`。
2. **记录：** 优先用 AssistantMessage.usage；没有则用现有估算。Harness 记住 usedTokens，屏幕只显示 used/window。正常对话追加消息，压缩换成摘要＋原样尾部。Chat 的字符串思考已按 adapter 策略回传，默认 omit；文字、图片和工具调用继续按角色转换。
3. **显示：** 接口是 `contextUsage(): { used: number; window: number | undefined }`。没有模型时仍可查看用量，窗口显示“未配置”。REPL 每轮结束后显示 `ctx <used>/<window>`，`/context` 无参数读取同一份状态；修改窗口需要已有模型。
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
| `src/harness/harness.ts` | 装配、会话、设置、请求快照、用量与压缩；普通请求／摘要共享模型、偏好和逐请求凭据；取消不提交摘要 |
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
| `src/config/byok.ts` | 加载 cwd 下的 `byok.json` 或显式路径 JSON，校验连接与模型目录、选择启动模型并独立读取凭据；JSON 是唯一模型配置来源，缺失或损坏均报错；dotenv 代码和两个 env 文件已删除，本机 JSON 被 Git 忽略 |
| `src/cli/main.ts` | `runCli()` 先创建 Harness，再尝试应用 BYOK 配置；TTY 交互和非 TTY EOF 提交共用 REPL 逻辑，配置错误不阻止会话命令；导入不启动进程 |
| `src/cli/byok-runtime.ts` | 保存待尝试选择、有效配置及诊断，加载校验后通过回调应用设置；提供模型键和可恢复结果，不管理 Harness 生命周期 |
| `src/llm/adapter.ts`、`rules.ts`、`sse.ts` | 统一入口、adapter schema／配置校验／规则与编码模板、可复用 SSE 分帧；当前接入 Chat |
| `src/types.ts`、`src/agent/agent.ts`、`src/agent/loop.ts` | BYOK 公共数据、模型／偏好（含 adapter）快照、请求选项与 hook 的显式覆盖；线上字段留在协议适配器 |
| `src/index.ts` | 导出 Agent、Harness、流式适配和工具等现有入口 |
| `test/probe-harness.ts`、`test/probe-session.ts` | 已有框架与会话探针 |
| 本地 `test/probe-context.ts` | 假流探针覆盖自动压缩、上下文溢出重试与摘要失败；仅留本地，不随 Git 分发 |
| 本地 `test/` | 所有零散测试与探针均不跟踪、不提交；历史跟踪文件仅从 Git 移除，本地保留。对应 npm 入口已删除，后续另建测试框架 |

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
   └── llm/adapter.ts::streamModel → 协议实现（当前 openai-chat.ts）
```

BYOK JSON 由 config/byok.ts 加载；原 env.ts 和 dotenv 启动链已删除。连接凭据与无凭据模型目录分开。

---

## 5. 模块说明书

### 5.0 工具与图片输入

工具位于 `src/harness/tools/`，系统提示位于 `src/harness/prompt.ts`，由 `Harness` 装配。`createXxxTool` / `buildSystemPrompt` 是现有入口。

新输入异步读取图片文件/剪贴板，经回调把真实图片内容交给 `PromptInputController`，草稿显示 `[Image #N]`。提交时只收集仍被引用的图片，沿 `Harness.prompt(text, images?)` → `Agent.prompt(text, images?)` 传递；`read` 的图片放在对应的 `ToolResultMessage.content` 中。图片不进入文本粘贴 `chunks`。OpenAI 格式由 `openai-chat.ts` 转换；协议附加消息只在构造请求时生成，不作为真实用户输入写回会话，工具来源和图文顺序保留。

---

### 5.1 `src/harness/harness.ts`

**做什么：** `Harness` 类。开局装配；之后 `main` 只跟它说话。

```ts
export interface HarnessModelSettings {
  model: Model;
  modelRef?: ModelReference;
  thinking?: ThinkingPreferences; // 初始偏好，三协议各自编码
  apiKey?: string;
  getApiKey?: (model: Model) => string | undefined | Promise<string | undefined>;
}

export interface HarnessOptions extends Partial<HarnessModelSettings> {
  cwd: string;
  streamFn: StreamFn;
  sessionsRoot?: string; // 默认 ~/.cli-agent/sessions；探针用 tmp
  resolveModel?: (reference: ModelReference) => HarnessModelSettings;
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
  configureModel(settings: HarnessModelSettings): void;
  setThinkingLevel(level: ThinkingLevel): void;
  setThinkingEnabled(enabled: boolean | undefined): void;
  readonly settings: SessionSettings;
  readonly settingsWarning: string | undefined;
  describeSettings(): string;
  setContextWindow(tokens: number): void;
  contextUsage(): { used: number; window: number | undefined };
  manualCompact(): Promise<"compacted" | "below-threshold" | "nothing-to-compact">;
  compact(customInstructions?: string): Promise<boolean>; // 已实现；false 表示没有可压的旧历史
}
```

**现有框架：** 构造时创建四个工具、系统提示和 Agent，允许模型未配置。`configureModel()` 在空闲时更新模型、偏好与凭据来源，保留消息、会话及订阅。`prompt()` 先检查模型并解析凭据，再调用 Agent；压缩也在内部检查。`abort` / `subscribe` 转给 Agent。`newSession` 调 `agent.reset()` 再换会话句柄，`resumeAt` 加载消息并重算用量，两者均不依赖模型。`prompt` 优先用接口 usage 更新 `usedTokens`，取不到则估算；自动压缩与 `compact()` 已接通。`manualCompact()` 检查模型、手动用量门槛和压后是否有新消息，再调用同一个 `compact()`。思考 setters 校验并记录设置；prompt 快照贯穿生成、自动摘要和溢出重试，工具续接／摘要重试重新取 Key。

**对照：** 角色可参考 Pi 的 `AgentSession`，API 采用本项目设计。extensions、队列和树导航不在当前版本范围；按本次任务需要阅读相关实现。

---

### 5.2 `src/harness/session.ts`

**做什么：** cwd 目录编码、建文件、append、读回 AgentMessage；会话名和列表也在这里。消息中的 thinking／replay 随 JSONL 保存，settings 行只保存模型目录引用和偏好。loadSession 分别返回消息和最后设置，不从会话加载旧 URL／Key。

- `sessionDirForCwd(cwd, sessionsRoot?): string` → `~/.cli-agent/sessions/--encoded--/`（`sessionsRoot` 默认家目录那份，探针指到 tmp）
- `sessionTitleFromUserText(text): string` → 前 10 个字符，见 §2
- `createSessionFile(...)` 只准备路径和 header（此时 `name` 可空），第一条 assistant 才 `writeFile` header + 已攒的行；flush 前用第一条 user 文本填 `header.name`
- `appendEntry(entry)`
- `loadSession(path): { messages, name }`
- `listSessions(cwd, sessionsRoot?): { filePath, name, lastOpenedAt }[]` 按 mtime 新到旧；`name` 优先 header，缺则从第一条 user 消息现算
- `findMostRecentSession(cwd): string | undefined` 即列表第 1 条的 path
- `touchSession(path)`：更新 mtime（resume 时调用）

当前格式包含 settings 行，不包含树、lane 或 session_info。compaction / 用量相关行的读写也走这里，类型放在 `session.ts`。`HarnessOptions.sessionsRoot?: string` 默认 `~/.cli-agent/sessions`。

**对照：** `pi/packages/coding-agent/src/core/session-manager.ts` 的 `getDefaultSessionDirPath` 和 `_persist` 中延迟落盘的处理。当前借鉴目录组织和延迟建文件的思路；标题规则、线性格式和恢复交互由本项目确定。

---

### 5.3 上下文容量（`context.ts` + `compaction.ts`）

压缩的前提是：**知道窗口有多大**，以及 **当前用了多少**。这个功能包含窗口、计量、显示和自动压缩，分多个可 review 的小点接通。

**窗口**

- `Model.contextWindow: number`（必填于运行时）。由 BYOK JSON 的当前模型配置提供，配置缺失或无效时报错。
- `/context <n>` 改 `harness.setContextWindow`，写的仍是当前这份 `Model.contextWindow`。模型能力信息来源随思考等级与 BYOK 一起确定。

**记录**

- `AssistantMessage` 增加可选 `usage?: { input: number; output: number; totalTokens?: number }`。
- `openai-chat.ts`：默认请求带 `stream_options: { include_usage: true }`，可由 adapter.includeUsage 关闭。usage 在 choice 之前解析，可出现在独立尾块或 finish_reason 同块；字段映射 prompt_tokens→input、completion_tokens→output，input 不扣缓存。未返回 usage 时不写此字段。
- 用量取最后一条 assistant 的 `input + output`（下次请求要重发的量）。取不到则 harness 通过现有 `estimateTokens` 估算整段 messages，文字按字符/4，图片按固定开销估。
- 每次 `prompt` 结束后更新 `usedTokens`。session 不必为每一轮单开 usage 行；压缩发生时 `compaction` 行可带 `tokensBefore`。

**显示（CLI，不是网页）**

- 对外只有 `used` 和 `window`。`contextUsage()` 返回这一对。REPL 例如打 `ctx 12345/256000`，`/context` 无参数打印同一对。启动、`/context <n>` 之后和每轮结束都用同一种形状 `ctx <used>/<window>`，不另打只含窗口的格式。
- 不在屏幕上拆 input、output、cache，也不打距离压缩阈值还剩多少。
- 本版不做进度条、主题色、TUI footer。以后增加 TUI 时复用 `contextUsage()`。

**发给模型的前缀（缓存）**

- 正常对话每轮在末尾追加本轮的 user / assistant / toolResult。已经发过的系统提示、工具列表和更早的消息保持字节不变，以便复用服务端的前缀缓存。
- 流式生成只替换当前这一条还没写完的 assistant。不回头改旧消息的正文，不往系统提示或旧消息里写时间、用量。
- 思考块与完成后附加的 replay 留在本地记录里；Chat 按 omit／same-source／required 策略在请求副本中处理历史思考，不改原 session。文字、图片和工具按角色转换，保持相同历史转换的一致性。
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

手动 `/compact` 只在用量过 1/4 时运行现有摘要；无旧历史或刚压完没有新消息时提示。成功追加 compaction，内存换成摘要＋保留尾部；失败不换历史。分支摘要、文件列表元数据和宽 length 恢复不在本版。三协议思考链已接通，摘要传入当前思考偏好，逐请求动态凭据与预算重新校验均已接通；摘要只收普通正文。

**对照：** `pi/packages/agent/src/harness/compaction/compaction.ts` 的 `DEFAULT_COMPACTION_SETTINGS`、`shouldCompact`；`pi/packages/ai/src/utils/overflow.ts` 的 `isContextOverflow`：错误文本、`stop` 且 input 超窗、`length` 且输出为 0。当前不接 `isRecoverableLength`；显示和窗口配置采用本项目设计。

---

### 5.4 思考等级与 BYOK（约定功能已实现）

统一设置链、选定厂商和本地验收已完成，既有 review 尾项保留。配置入口见 [厂商示例](../byok.providers.example.json)，模型绑定在 `src/llm/rules.ts`，命令见 README，验证记录见 [开发进度](./progress.md)。两份 BYOK 专题文档已按用户要求退役。

配置使用 cwd 的 byok.json 或明确指定的路径；loadByokConfig 校验连接／模型目录并分离凭据。连接与模型可填 adapter：模型按字段覆盖连接默认，其中 thinking 整条替换。运行时模型不含凭据，adapter 随 createLoopConfig 的 structuredClone 一起快照；现有 loop 与内部 hook 行为继续复用。

runCli 使用统一 streamModel，三协议均已接通。Chat 的 prepareChatRequest 选择规则，映射思考，序列化历史与工具，校验输出上限；fetch 只负责 HTTP；readSSE 解析正文、思考、工具与 usage，输出已有事件，不新增工具循环。rules.ts 集中保存 schema、规则选择与 effort／toggle／budget 模板，sse.ts 负责与 HTTP chunk 无关的分帧。

用户固定五档和独立开关：未指定开关不发思考控制，开启按原生顺序映射或直接查五档预算；关闭保留档位，必须有真实关闭编码。合并输出限额的预算规则为回答预留空间，装不下最低预算则失败。未知接口不猜 effort；用户明确配置优先于明确启用的预设／模型绑定，再使用协议默认。OpenAI 绑定 GPT-5.1/5.2，其他厂商按 rules.ts 中的有限型号绑定，不自动套用未来型号。

Chat 可按配置解析 reasoning_content 或 reasoning 字符串，保留与正文交错的顺序。验证整条流完整结束后才给思考片段附 replay；source 含协议、连接、模型和规范化实际推理 URL。历史按 omit／same-source／required 策略处理，只发送完整同源数据；旧显示文字不当成原生数据，原 session 不变。截断／错误／取消不附 replay，未完成工具调用不作为合法调用落盘。Responses 使用无服务端会话依赖的 store:false／input items，按厂商规则处理加密 reasoning、明文 content 数组／对象或 summary；只有加密模式发送 encrypted_content include。Anthropic 默认回传完整 thinking 签名与 redacted-thinking，兼容规则可允许无签名、选择 Bearer 及独立预算；Claude 默认预算工具续接仍校验必要数据。字符串工具结果的图文附件在整批工具结果之后分组发送。Chat 已接通 MiniMax reasoning_details 与 Gemini thought_signature；36 个连接预设在 config/presets.ts 中维护，模型范围由 rules.ts 的有限绑定确定。

配置错误恢复、模型／思考设置、逐请求凭据、压缩设置、JSONL 恢复和显示已全部接通。新增源码为 config/presets.ts，公共可选 replay 扩展到 ToolCall 和 AssistantMessage 以承载 Google 签名。protocol-utils.ts 共用传输、取消、能力检查与事件函数；协议各自校验消息和结束条件。原生结束原因另存 rawStopReason；Anthropic usage.input 合计普通输入与缓存写入／读取。真实配置未修改，实际 DeepSeek 覆盖与网络失败见开发进度的 2026-10-20 记录。

---

### 5.5 `main.ts` 装配

启动：runCli 先创建 Harness，ByokRuntime 随后加载目录并回调应用模型、偏好与凭据解析函数，使用统一 streamModel；三协议均通过同一请求入口运行，缺参数或 HTTP 错误在操作内部报告。TTY 进入 startTerminalRepl；非 TTY 收集 UTF-8 输入到 EOF，再交给同一个 ReplController。

`npm start` 已恢复交互：输入完整草稿展开后调用 Harness，命令包括 `/new`、`/resume`、`/context`、`/compact`、`/help` 和 `/exit`。接受提交后清理整份草稿；生成时允许编辑下一条但不提前提交。Agent 事件由 REPL 投影到 Ink，不同时订阅直接写 stdout 的 `renderEvent`。退出、EOF、信号、回调异常统一清理订阅和终端模式；非 TTY 只打印模型/命令输出，退出码反映错误或信号。

---

## 6. 接下来如何推进

上下文容量与手动压缩已实现；本轮 BYOK 约定功能、九家厂商范围和本地验收完成，等待用户 review。真实地区账户、跨平台终端和公开试用准备继续按条件推进。v1.3 才做完整 TUI。

下表区分实现、review 与真实环境验证。不要在新对话重复搭建已完成的设置、协议或会话链；后续只按新增需求扩充。功能完成后验证，保持类型检查与构建通过。

| 步 | 做哪些文件 | 完成标准 | 主要对照 |
|---|---|---|---|
| 3 | 上下文容量：窗口、usage、显示、自动压缩和溢出重试 | 代码与假 `StreamFn` 验证已完成；真实模型压缩验收待做 | `shouldCompact`；`isContextOverflow` |
| 5 | 手动 `/compact` + 1/4 用量门槛 | 入口代码与假流验证完成；未过线不调模型，过线且有旧历史则生成摘要并落 `compaction`；待 review 和真实模型续聊验收 | 当前 `Harness.compact()`；`findCutIndex` |
| 4+6 | 思考等级与 BYOK：约定功能与选定厂商范围已实现 | 模型请求、工具、设置恢复和压缩本地验证通过；真实接口范围见开发进度 | Kimi、CC Switch、Pi 与官方文档 |
| 7 | REPL 按 §7 验收 | 功能验证完成并记录未覆盖的网关差异 | — |

session / 上下文探针只用临时目录，不要往 `src/` 或用户家目录的真实项目会话里写测试数据（probe 可把根目录指到 tmp，或抽 `sessionsRoot` 参数，默认 `~/.cli-agent/sessions`）。

---

## 7. 这一版验收

新 REPL 已接通，本机 115 项扩展输入测试通过，包括 macOS 真实 POSIX PTY、实际 Harness 与本地 HTTP SSE；所有测试文件现按用户要求只留本地，仓库不再提供对应测试脚本入口。下列清单仍包含真实模型、特定终端应用及仍需真实账户覆盖的思考/BYOK 验收，不能以本地测试替代。自动压缩与溢出形状由可控流探针验证；手动压缩只有在 `used > window / 4` 且存在可压旧历史时才发起摘要请求。例如配置窗口为 `256000` 时，手动门槛是 `64000`。

1. 普通对话 + `read` `package.json` 仍能工作（框架没把工具弄丢）。
2. 说一句话之后，`~/.cli-agent/sessions/--...--/` 下出现 jsonl，里面有 user / assistant；header 的 `name` 是那句话的前 10 个字符。
3. `/new` 后再说一句，同目录多一个文件，两份 `name` 能分开。
4. 退出再启动，整行输入 `/resume` 打印「名字 + 上次打开时间」列表，再输入序号接上那一份（能问「我刚才说了什么」对得上）。
5. 每轮结束后能看到 `ctx used/window`；`/context` 能打印；改窗口配置或 `/context <n>` 后窗口跟着变。假流探针覆盖阈值压缩、溢出报错、空 `length` 重试和 `stop` 超窗只压。`/compact` 在用量未过 1/4 时提示无需压缩；过线且有可压旧历史时用真实模型生成摘要，jsonl 有 `compaction` 行，续聊能利用摘要和保留的尾部。
6. 按最终确定的模型配置检查思考选项：能控制的档位与实际请求一致；不能控制或参数被拒绝时有明确反馈，兜底与重试行为可复现。模型切换保留偏好，/new 继承，/resume 按已加载目录解析会话引用。
7. 分别选择 OpenAI Chat Completions、Anthropic Messages、OpenAI Responses，使用自填 URL / key / 模型完成多轮文本、一次工具调用及结果回传；核对 usage、错误、中断和不支持图片时的明确提示。
8. `/new` 后工具还能用，且开始一份新会话。
9. 验收实际终端中的多行粘贴、独立 Enter、组合键、图片引用和 `/resume` 序号输入。Windows PowerShell、WebStorm 终端和 macOS Terminal 的手动结果分别记录，不能以单个平台的探针代替。

测完删掉临时 jsonl 和手测写的文件。

**公开试用评估：** v1.2 功能清单做完后，可以作为早期 CLI 试用版公开，不必等 v1.3 TUI；但发布前至少要建立可复现的测试框架并覆盖三种协议端到端验收，处理已知会影响正常使用的中断后工具配对、Windows bash 卡住和可恢复溢出错误提前显示问题。当前零散测试按用户要求不进入 Git。README 需要写清安装、配置示例、各协议能力与限制，以及工具会读写文件和执行命令；仓库还需明确许可证。以上是发布门槛，不表示这些问题当前已经解决。

---

## 8. Pi 源码阅读入口

按当前小点选择参考文件，无需一次通读整个 Pi。更完整的会话管理、TUI 或其他机制在实际需要时再展开；阅读范围不限制本项目未来的产品能力。参考位置以函数名定位，行号随 Pi 版本变化。

当前相关入口：

1. `session-manager.ts`：`getDefaultSessionDirPath`、`_persist` 延迟建文件
2. `harness/compaction/compaction.ts`：默认常量和 `shouldCompact`
3. 思考等级与 BYOK 参考同级新版 TS Kimi Code 的统一请求边界，以及 [CC Switch v4.0.9](https://github.com/farion1231/cc-switch/tree/v4.0.9) 的规则映射；Pi 的模型能力和协议处理作为补充参考
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
思考等级与 BYOK                    模型能力、三协议适配与有限绑定，已实现
cli/input/*                       新输入、完整附件草稿与撤销；参考 CC 输入链路
cli/repl/*                        提交展开、命令分派、Harness 事件与 Ink 显示
cli/main.ts                       Harness 装配；TTY 交互 / 非 TTY EOF 提交
```
