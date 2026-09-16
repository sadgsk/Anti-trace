# 当前进度

给换对话、换模型用的状态板。新对话先读这一页，再打开架构书。

| 项 | 值 |
|---|---|
| 项目 | `e:\pi-harness\cli-agent`（与 `e:\pi-harness\pi` 并列） |
| 当前版本 | **v1.2** |
| 阶段 | **开写：第 0 步搬家（tools / prompt → harness）** |
| 架构书 | [architecture.md](./architecture.md) |
| 暂不修的 bug | [future-issues.md](./future-issues.md) |
| 对照代码 | `e:\pi-harness\pi` |
| 最后更新 | 2026-09-16 |

**协作约定（带着写源码时必须按这个格式，换对话不用用户再重复）：**

1. 一次只做一个函数。聊天里先讲清楚，**讲完由助手把这一步写入源码文件**。用户不用手动粘贴。写入文件 ≠ git commit；未明确说 `git commit` 时不要做版本提交。
2. 回复固定四段，然后立刻改文件：
   1. **这部分要实现什么**（一两句话，只点这一个函数）
   2. **对应代码**：对话里放出这一个函数的完整定稿（若它现在就需要专属类型，一并给出且以后不再改）。append 进文件，禁止整文件覆盖。不要给占位再回头改同一段。
   3. **参考原本哪部分**（Pi 文件路径 + 函数名 + 行号）
   4. **相对 Pi 改了什么**（哪一刀先瘦、哪一刀补到产品级，写清楚）
3. 已写好的函数后面不再改同一段。瘦实现和产品级补强是后一刀加在旁边或一次性换 execute 内部，不要反复改 schema 名字。搬家只改路径和 import，不改工具函数体。
4. 用户问概念时直接回答，不必套四段，也不改文件。
5. 遇到 bug 但暂时不修：记到 [future-issues.md](./future-issues.md)，编号接着 `No.N`，写平台 / 日期 / 项目版本 / 现象，不要写修法。这份文档要进 git。

---

## 新对话怎么接

1. 读本文件（进度 + 文首协作约定）。
2. 读 [architecture.md](./architecture.md) 的 §1–§4。
3. 从当前版本的「下一步」接着做。带着写时用文首四段格式。
4. 做完一步后：勾选当前版本清单，改文首「阶段 / 最后更新」，在**当前版本**的更新记录里追加一条。

这一版做自己的 `Harness`，不拿 Pi `AgentSession` 当规范。Agent / loop 怎么跑，读源码。Pi 只对照架构书 §5 点名的那几处。

---

## v1.2（当前）

要做：搬家 → 管家框架 → session 记忆 → 自动压缩 → 思考等级。基本能用即可。

**下一步：** 第 0 步，架构书 §6：搬家。

| 步 | 内容 | 状态 |
|---|---|---|
| 0 | 搬家：`src/tools/*` → `src/harness/tools/`，`prompt.ts` → `src/harness/prompt.ts`，改 import | [ ] |
| 1 | `src/harness/harness.ts` 框架 + `test/probe-harness.ts`；`main.ts` 改用 Harness | [ ] |
| 2 | `src/harness/session.ts` + probe；Harness 写入 / `/new` / `/resume` | [ ] |
| 3 | `src/harness/compaction.ts`；回合后自动压 + `/compact` | [ ] |
| 4 | 思考等级：`createLoopConfig`、`openai-chat`、`/thinking`、session 行 | [ ] |
| 5 | 架构书 §7 REPL 验收 | [ ] |

### v1.2 更新记录

| 日期 | 发生了什么 |
|---|---|
| 2026-09-16 | 施工顺序定为：搬家 → 框架 → session → 压缩 → 思考。 |
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
