# 开发进度与历史

记录各版本做过的改动，以及当前版本还有哪些工作和验收未完成。新对话先读这一页，再打开架构书了解当前设计和后续目标。下方历史记录保留当时的决定；已被替代的旧约定不作为今天的开发规则。

| 项 | 值 |
|---|---|
| 项目 | `e:\pi-harness\cli-agent`（与 `e:\pi-harness\pi` 并列） |
| 当前版本 | **v1.2** |
| 阶段 | **第 0–2 步完成；第 3 步窗口/用量/显示已接通（用量优先用接口 usage），压缩待做；下一步继续第 3 步上下文容量** |
| 架构书 | [architecture.md](./architecture.md) |
| 暂不修的 bug | [future-issues.md](./future-issues.md) |
| 对照代码 | `e:\pi-harness\pi` |
| 最后更新 | 2026-09-24 |

**当前协作约定：** 产品方向和框架原则见 [架构书 §0](./architecture.md#0-产品方向与推进方式)。

1. 实现一个功能时，一次最多改三个函数（含必要类型和接线）；超出的留到下一批。每批动手前先说要动哪几个函数、各自做什么，再写入文件；写完停下等用户 review，确认后再继续下一批。用户不用手动粘贴代码。
2. 一个功能全部实现完再开始测试，不在功能做到一半插入探针或验收；验证方式和结果在功能完成后一起交代。
3. 实现过程中发现问题（设计冲突、边界情况、影响面）当场说明，不要等写完、用户 review 完再补一句「这里有问题」。
4. 带着写时，讲解应覆盖参考来源和本项目的取舍；有 Pi 对照时给出路径、函数名，自定义设计则直接说明理由。表达形式按内容选择，不固定为四段。
5. 已确定的框架可以先留接口或函数，明确未实现状态，后续继续填充。允许修改已有实现和类型，以局部、可审阅的差异推进，减少不必要的重写。
6. 用户问概念时先回答；是否同时修改代码按当次请求执行。未明确要求 `git commit` 时不做版本提交。
7. 暂不处理的 bug 记录到 [future-issues.md](./future-issues.md)，沿用编号并写清环境、版本、现象和影响；已确认的原因或处理方向可以补充，并与待验证推测区分。

---

## 新对话怎么接

1. 读本文件的当前状态、协作约定和待办。
2. 读 [architecture.md](./architecture.md) 的 §0–§4，按当前小点再看模块说明和相关源码。
3. 按用户当前安排，从「下一步」选一个小点推进。历史更新记录不重新变成待做任务。
4. 做完一个小点后，记录实际实现和验证结果，更新「阶段 / 最后更新」以及相关待办；整个里程碑完成后再勾选，不因已有占位就标完成。
5. 版本收尾时保留本版本历史，由用户确定下一阶段目标，再同步架构书和新的版本待办。

当前采用自己的 `Harness` 和功能设计。Pi 用作按需阅读的参考；具体运行行为以仓库源码为准。

---

## v1.2（当前）

既定目标：搬家 → 管家框架 → session 记忆 → 上下文容量（窗口/计量/显示/压缩） → 思考等级。逐步补齐可完整运行的核心能力，框架按持续演进的方向设计，实现按小点交付。

**图片插入项已收尾：** OpenAI 图文关联修复通过本地请求体验收：本批全部 tool 回复连续，含图结果的完整内容按工具来源分组发送，图文顺序保留；普通 user 图文输入也保持原序。纯文字、空结果、批次边界和重复转换均已验证。未调用真实模型，本次验收范围是消息序列化；中断后的工具配对问题不在本次修复范围。

**主线下一步：** 继续第 3 步，见架构书 §6。窗口、估算用量和显示已接通；`compaction.ts` 已有设置、默认常量和 `shouldCompact`。接着分小点补齐接口 usage 解析、摘要和自动压缩，不接 `/compact`。每轮结束后按阈值压；上下文装不下时，报错或空 `length` 则压一次并重试，`stop` 且 input 超窗则只压、不重试。

| 步 | 内容 | 状态 |
|---|---|---|
| 0 | 搬家：`src/tools/*` → `src/harness/tools/`，`prompt.ts` → `src/harness/prompt.ts`，改 import | [x] |
| 1 | `src/harness/harness.ts` 框架 + `test/probe-harness.ts`；`main.ts` 改用 Harness | [x] |
| 2 | `src/harness/session.ts` + probe；Harness 写入 / 会话名（前 10 字）/ `/new` / `/resume`（名字+上次打开时间） | [x] |
| 3 | 上下文容量：`context.ts` + `compaction.ts`；usage；REPL `ctx`；`/context`；阈值压缩；报错或空 `length` 重试；`stop` 超窗只压 | [ ] |
| 4 | 思考等级：`createLoopConfig`、`openai-chat`、`/thinking`（跟 harness，不入盘） | [ ] |
| 5 | 架构书 §7 REPL 验收 | [ ] |

第 3 步的内部状态：

- 已接通：`Model.contextWindow` 与环境配置（`env.ts` 读 `OPENAI_CONTEXT_WINDOW`，缺省 `128000`，非正整数回退）、`estimateMessagesTokens` 整段估算、`Harness.setContextWindow` / `contextUsage`、REPL `/context` 与每轮后的 `ctx used/window`。`usedTokens` 在 `prompt` 结束后重算，`newSession` 归零，`resumeAt` 按加载的 messages 重算。
- 已接通：接口 `usage`。`AssistantMessage.usage?`；`openai-chat.ts` 请求带 `stream_options: { include_usage: true }`，在 `choice` 判断之前解析流末尾 usage 块并写入 assistant；`harness.ts` 的 `prompt` 优先取最后一条 assistant 的 `input + output`，取不到回退 `estimateMessagesTokens`。假 stream 已覆盖两条支路（`probe-harness` 用例 7）；deepseek 已实测返回 usage 且端到端解析正确。
- 已有实现：`CompactionSettings`、`DEFAULT_COMPACTION_SETTINGS`、`shouldCompact`。
- 待实现与接通：切点、摘要、压缩写回与持久化、自动触发及一次重试。
- 待验收：上下文探针和第 5 步端到端验收。已有基础函数不代表整个上下文容量功能完成。

下面更新记录中的压缩、usage、窗口和思考规则包含设计决定，是否已实现以当前清单为准。

### v1.2 更新记录

| 日期 | 发生了什么 |
|---|---|
| 2026-09-24 | 第 3 步第一小点：窗口 + 估算用量 + 显示。`Model.contextWindow` 设为必填；`env.ts` 读 `OPENAI_CONTEXT_WINDOW`（缺省 `128000`，非正整数回退缺省）并导出 `DEFAULT_CONTEXT_WINDOW`；`context.ts` 增加 `estimateMessagesTokens`；`Harness` 接通 `setContextWindow` / `contextUsage`，`usedTokens` 在 `prompt` 后重算、`newSession` 归零、`resumeAt` 按加载的 messages 重算；`main.ts` 启动打印 `ctx window`，新增 `/context`（无参数打 `ctx used/window`，带正整数改窗口）和每轮后的 `ctx used/window`。`agent.ts` 的 `DEFAULT_MODEL` 补占位 `contextWindow: 0`，注释说明 Harness 永远传入真模型。验证：`npm run typecheck`、`npm run test:images`（13 例）、`npm run probe:session` 均通过；`probe-harness` 原「未接上的方法 throw」用例改为「仍未接上」（只剩 `setThinkingLevel` / `compact`），并新增用例 6 覆盖窗口/用量/`newSession`/`resumeAt`。压缩、接口 usage 解析、上下文探针和 §7 端到端验收未做。 |
| 2026-09-24 | 第 3 步第二小点：接口 usage。`AssistantMessage` 加可选 `usage?: { input; output; totalTokens? }`；`openai-chat.ts` 请求体加 `stream_options: { include_usage: true }`，并在 `choice` 判断之前解析流末尾的 usage 块，字段只改名 `prompt_tokens`→`input`、`completion_tokens`→`output`，`input` 不扣缓存；`harness.ts` 的 `prompt` 优先取最后一条 assistant 的 `input + output`，取不到回退 `estimateMessagesTokens`（新增私有 `usageFromLastAssistant`）。验证：`npm run typecheck`、`probe:session`、`test:images` 通过；`fake-stream.ts` 增加可选 `usage`，`probe-harness` 新增用例 7 覆盖「有 usage 取 input+output」「无 usage 回退估算」「上一条有 usage 但本条没有时不沿用旧值」。真实网关已实测（`test/probe-usage.ts`，deepseek）：HTTP 200，接受 `stream_options`，返回 usage，字段为 `prompt_tokens`/`completion_tokens`/`total_tokens`；端到端 `streamOpenAIChat` 写出 `{"input":32,"output":19,"totalTokens":51}`。注意 deepseek 把 usage 与 `finish_reason` 放在同一块（`choices` 非空），标准 OpenAI 是空 `choices` 的独立块，先读 usage 的顺序兼容两种。附带发现：deepseek-flash 返回 `reasoning_content`（第 4 步可用）。 |
| 2026-09-24 | 第 3 步第一小点的两个决定。（1）`ctx` 显示统一成 `used/window` 一种形状：启动打 `ctx 0/<window>`，`/context`、`/context <n>` 之后和每轮结束都打 `ctx <used>/<window>`，不再出现单独的 `ctx window=`。（2）`Model.contextWindow` 保持必填。理由是按 BYOK 考虑：宽松留给配置层（`env.ts` 的 `parseContextWindow` 缺省 / 回退），严格留在运行时类型，下游（`contextUsage`，以后的压缩）不必写 `??`；用户在用 BYOK 配模型时基本都会填窗口。「配置层可省、运行时必有」两件事现在就已同时成立。 |
| 2026-09-22 | 图文关联修复通过本地验收：`npm run test:images` 的 13 个用例、`npm run typecheck` 均通过；另以 mock fetch 独立验证 48 种组合，覆盖同名工具、不同图片 MIME、真实 user/assistant 边界、冻结输入和重复请求。含图工具结果保留来源及内容顺序，整批 tool 回复后再发送附件；普通 user 同样保序。独立组合检查为一次性内存脚本，未写入仓库；未调用真实模型，未修复中断配对问题。 |
| 2026-09-22 | 文档整理：明确目标为可开源的产品级个人 agent；Pi 为参考，功能按用户设计；框架可先搭好并预留入口，每次实现几个相关函数供 review。架构书保存当前状态与后续目标，本页保留历史与当前待办。同步记录容量基础函数已存在但未接通；不改变既定 v1.2 目标，不代表图片修复或其他代码功能已完成。 |
| 2026-09-22 | 剪贴板三平台都先读位图，没有再读文件路径。只缩小临时副本，不动用户原文件。 |
| 2026-09-22 | 用户消息可以带图片。Windows `Alt+V`、macOS/Linux `Ctrl+V` 读剪贴板，最长边缩到 2000，和文字放进同一条 user。没有图片的消息仍按纯文字发送。 |
| 2026-09-22 | 图片发出去之前把最长边缩到 2000。仍不看模型是否收图片。 |
| 2026-09-22 | 上下文容量先停一下，补图片：不判断模型是否多模态，`read` 到 jpeg/png/gif/webp 就放进上下文并发出去。 |
| 2026-09-22 | 发给模型的前缀每轮只追加，旧消息和系统提示不动，以便命中缓存。思考不进请求。只有压缩把前缀换成摘要 + 原样尾部。 |
| 2026-09-22 | 切点只放在 user 之前，整轮留下或整轮压掉。摘要限输出为 `reserveTokens` 的 80%；失败不改内存；旧摘要放进下一次输入，正文标明是压缩上文。 |
| 2026-09-22 | 容量显示只留 `used` / `window`，`contextUsage()` 先提供这一对，TUI 以后读这里。窗口字段在 `Model.contextWindow`：这一版用 `OPENAI_CONTEXT_WINDOW` 填入，以后改成配置模型时的一项。 |
| 2026-09-22 | 补上协议里另外两种装不下：`stop` 且 `usage.input > window` 时压缩、不重试；`length` 且输出为 0、input 顶满窗口时丢掉空回复，压完重试一次。仍不做有正文的宽 `length` 恢复。 |
| 2026-09-22 | 第 3 步压缩入口改了：不接 `/compact`。自动仍是两处：一句正常结束后用量过线就压、不重试；模型报上下文满了则丢掉该条报错，压完重试这一轮一次。 |
| 2026-09-19 | 第 2 步完成：`test/probe-session.ts` 覆盖延迟建文件、会话名、列表/mtime、磁盘读回、compaction 切摘要；`/new` `/resume` 已接到 REPL。 |
| 2026-09-19 | `/resume` 改为先列名单再选序号（`resumeAt`），去掉自动打开最近一份的 `resumeRecent`。 |
| 2026-09-19 | 去掉 `Harness.reset` 和 REPL `/reset`。开新会话只用 `newSession` / `/new`；`Agent.reset` 仍只清内存。 |
| 2026-09-17 | 会话名改为第一条 user 文本前 10 个字符（不够则全留），不再切第一句。 |
| 2026-09-17 | thinking 档位改为只跟 Harness：开局默认 `off`，`/thinking` 改本进程这份；`/new` `/resume` `/reset` 不改档，jsonl 不写 `thinking_level_change`。 |
| 2026-09-17 | 架构书补上会话名：第一条 user 的第一句再截 10 字，不跑 LLM；`/resume` 用名字 + 上次打开时间列表分辨（`/resume` 最近一份，`/resume n` 按序号）。 |
| 2026-09-16 | 第 1 步完成：Harness 框架；`main.ts` 不再 createXxxTool / new Agent；`probe-harness` 假 stream 能 prompt。 |
| 2026-09-16 | 第 0 步搬家完成：`src/harness/tools/*`、`src/harness/prompt.ts`；import 已改。`tsc --noEmit` 与 probe-read/write/edit/bash/agent/loop 通过。 |
| 2026-09-16 | 第 3 步从「只压缩」改为上下文容量：窗口设置、用量记录、CLI 显示、再压缩。 |
| 2026-09-16 | 施工顺序定为：搬家 → 框架 → session → 上下文容量 → 思考。 |
| 2026-09-16 | 开 v1.2。架构书换成 harness 框架；不按 AgentSession 约束。施工从搬家起。 |

---

## v1.1（已闭合代码；§7 手测未做）

做了什么：按 Pi harness 加上 `read` / `write` / `edit`，装配进 REPL。`bash` 留下。探针：`probe-read` / `probe-write` / `probe-edit`。§7 REPL 手测未勾，不挡 v1.2。

| 步 | 内容 | 状态 |
|---|---|---|
| 0 | `src/tools/path-utils.ts` | [x] |
| 1 | `src/tools/read.ts` + `test/probe-read.ts` | [x] |
| 2 | `src/tools/write.ts` + `test/probe-write.ts` | [x] |
| 3 | `src/tools/edit.ts` + `test/probe-edit.ts` | [x] |
| 4 | 装配：`main.ts` `prompt.ts` `index.ts` | [x] |
| 5 | 架构书 §7 REPL 验收 | [ ] |

### v1.1 更新记录

| 日期 | 发生了什么 |
|---|---|
| 2026-09-16 | 闭合代码阶段，开 v1.2。§7 手测仍未做。 |
| 2026-09-15 | 装配：`main.ts` 挂上 read/bash/edit/write；`prompt.ts` 写清四个工具用途；`index.ts` 导出三个 create 函数。 |
| 2026-09-15 | 写入 `createEditTool` + `probe-edit.ts`：一处成功、0 次 / 2 次 throw、两项不重叠、abort。prepareArguments / 换行归一 / diff 后一刀。 |
| 2026-09-14 | 拿掉 `resolveCwdPath` 的工作区铁墙：对齐 Pi，相对 `cwd` resolve 即可，不因在 cwd 外 throw。 |
| 2026-09-14 | 写入 `createReadTool`（文本第一刀）+ `probe-read.ts`：小文件带行号、缺文件 throw、超大截断、abort。图片后一刀。 |
| 2026-09-14 | `resolveCwdPath` 去掉剥 `@`：这边还没有 `@` mention，留给后一刀。 |
| 2026-09-14 | 非独立工具辅助改名：`path.ts` → `path-utils.ts`，对齐 Pi 的 `path-utils.ts`。函数未改。 |
| 2026-09-14 | 写入 `resolveCwdPath`：resolve 到 cwd、越界 throw、abort throw。 |
| 2026-09-13 | 开 v1.1。架构书收成一份，施工从 `path.ts` 起。 |

---

## v1（已闭合）

做了什么：骨架 + REPL。能多轮对话、`bash`、流式输出、abort、`/reset` `/exit`。探针：`probe-llm` / `probe-bash` / `probe-loop` / `probe-agent`。本机用 bash 列目录跑通。

| 步 | 内容 | 状态 |
|---|---|---|
| 0 | 平行目录 + 架构书 | [x] |
| 1 | `package.json` `tsconfig.json` `types.ts` | [x] |
| 2 | `event-stream.ts` | [x] |
| 3 | `openai-chat.ts` + probe-llm | [x] |
| 4 | `bash.ts` + probe-bash | [x] |
| 5 | `loop.ts` + probe-loop | [x] |
| 6 | `agent.ts` `prompt.ts` + probe-agent | [x] |
| 7 | `render.ts` `main.ts` `index.ts` | [x] |
| 8 | REPL（对话 / bash / 多轮） | [x] |

### v1 更新记录

| 日期 | 发生了什么 |
|---|---|
| 2026-09-09 | 建 `cli-agent/`，写下 v1 架构书。源码未开工。进度文档建立。 |
| 2026-09-09 | 装好工程脚手架：`package.json`、`tsconfig.json`、依赖。代写的 `src/types.ts` 已撤回；源码改由用户对照 Pi 自己写。 |
| 2026-09-09 | 建了空的 `src/types.ts`，内容未写。 |
| 2026-09-09 | `types.ts` 补全：AgentContext、Loop hook、AgentLoopConfig、AgentState、AgentEvent。`tsc --noEmit` 通过。 |
| 2026-09-11 | 建了空的 `src/llm/event-stream.ts`，内容未写。 |
| 2026-09-11 | 用户写完 `event-stream.ts`（EventStream + AssistantMessageEventStream）。下一步 openai-chat。 |
| 2026-09-11 | 建了空的 `src/llm/openai-chat.ts`。 |
| 2026-09-11 | 写入 `openai-chat.ts`：v1 切片（fetch + SSE，不抄 Pi 的 retry/compat/thinking）。 |
| 2026-09-11 | 按用户要求清空 `openai-chat.ts`，改由用户对照 Pi 逐函数重写。 |
| 2026-09-11 | 写下「带着写」四段格式（做什么 / 给出代码 / Pi 对照行号 / 相对 Pi 的改动），换对话沿用，用户不必再说明。 |
| 2026-09-11 | 代码改为 append：只给新增片段和要改的那几行，禁止整文件覆盖贴。 |
| 2026-09-11 | 按用户要求：一次一个函数、实现一次就定稿不再改；`openai-chat.ts` 改回第一次粘贴的壳。 |
| 2026-09-11 | 协作改为：聊天讲解后由助手写入源码，用户不用粘贴；未明确说 `git commit` 时不要做版本提交。 |
| 2026-09-12 | 建 `test/probe-llm.ts`，用环境变量读 key，不把密钥写进仓库。 |
| 2026-09-12 | 增加 `.env` / `.env.example` 和 `src/env.ts`；v1 配置为 key + baseUrl + model。 |
| 2026-09-12 | 修 SSE 空 buffer 误 break。探针：纯文本「好」+ echo toolCall 通过。 |
| 2026-09-12 | env 改为 Pi 形状：`auth.json` 存 key，`models.json` 存 baseUrl/model；不再解析 `.env`。 |
| 2026-09-12 | 按用户要求先退回 `.env` 测试；auth.json / models.json 以后产品化再加。 |
| 2026-09-12 | 写完 `bash.ts`。`test/probe-bash.ts`：echo hello、exit 1 不抛错、abort throw，均通过。 |
| 2026-09-12 | 第 5 步先写入 `createFakeStreamFn`；按用户要求放到 `test/fake-stream.ts`，不进 `src/`。 |
| 2026-09-12 | `loop.ts` 补齐 `streamAssistantResponse`、`failToolCallsFromTruncatedMessage`、`executeToolCallsSequential` 及校验/execute 辅助函数。`tsc --noEmit` 通过。 |
| 2026-09-13 | 写完 `test/probe-loop.ts`。四例通过：纯文本、先 toolCall 再文本、模型 error、length 截断不 execute。第 5 步勾上。 |
| 2026-09-13 | 写完 `agent.ts`、`prompt.ts`。`test/probe-agent.ts`：prompt(hi)、toolCall、reset 通过。第 6 步勾上。 |
| 2026-09-13 | 写完 `render.ts`、`main.ts`、`index.ts`。第 7 步勾上。 |
| 2026-09-13 | 本机 REPL 用 bash 列目录跑通。v1 闭合。 |
