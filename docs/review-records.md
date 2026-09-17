# Review records

代码评审记录。`No.1`、`No.2`… 一个 `No.` 记一次评审，问题写在这次评审里面，从 `问题1` 往后排。

约定：

- 每条要有：**评审号、评审日期、评审模型、平台、项目版本、仓库快照、评审范围**。
- 评审结论只从**代码结构**得出，不引用评审当时之外的任何文档（README、architecture、progress 一律不看），避免被既有叙述带偏。
- 每个问题写：位置、现象、证据、建议方向。**建议方向不是定稿修法**，动手时以当时代码为准，和 `future-issues.md` 的"不写修法"原则不冲突——那份记现象，这份记判断。
- 能复现的问题附复现脚本路径。实测结果写在"证据"里，没实测的一律标 **未验证**。

---

## No.1 — 第一次评审

| 项 | 值 |
|---|---|
| 评审号 | No.1 |
| 评审日期 | 2026-09-16 |
| 评审模型 | deepseek-flash |
| 平台 | Windows（本机 `win32 10.0.26200`），Node `v24.14.1` |
| 项目版本 | v1.2（`package.json` `0.1.0`） |
| 仓库快照 | `main` `7795897`（`https://github.com/sadgsk/Anti-trace.git`），工作区干净 |
| 评审范围 | `src/` 全部 17 个文件：`types.ts`、`agent/agent.ts`、`agent/loop.ts`、`harness/harness.ts`、`harness/prompt.ts`、`harness/tools/{read,write,edit,bash,path-utils}.ts`、`llm/{openai-chat,event-stream}.ts`、`cli/{main,render}.ts`、`env.ts`、`index.ts` |
| 评审方式 | 通读源码；对其中两条用假 `StreamFn` 实测复现（脚本见文末）；`tsc --noEmit` 通过 |
| 复核 | 2026-09-16，对照 `src/` 重读，并重跑文末两条探针。原稿 13 条里，计划中的占位、类型扩展口、产品选择和说重了的条目已删；留下的两条按实测改过表述 |

**总体判断**

分层本身是干净的：`types` → `agent/loop` → `agent` → `harness` → `cli` 依赖单向，loop 不认识 readline，harness 不认识 HTTP，工具各管一件事。`tsc --noEmit` 全过，下面没有类型错误。

当前会踩的只有两处：中断一批多个 tool call 会留下配对不齐的 transcript，下一句用户输入才会把协议打爆；bash 输出没有上限，和 read 的截断策略不对称。

**问题索引**（按严重度排序，P0 会让会话直接不可用，P1 每天用会疼）

| # | 问题 | 级别 |
|---|---|---|
| 1 | 中断后 tool call 配对缺失，下一轮用户输入会变成协议非法 | P0 |
| 2 | bash 工具输出没有上限 | P1 |

---

### 问题1 — 中断后 tool call 配对缺失，下一轮用户输入会变成协议非法

| 项 | 值 |
|---|---|
| 位置 | `src/agent/loop.ts:298-301`（`if (signal?.aborted) break;`） |
| 级别 | P0 |
| 状态 | **已实测复现**（`test/probe-abort-pairing.ts`） |

**现象**

一批多个 tool call，执行到中途被 abort 时，`executeToolCallsSequential` 直接 `break`，同一批里还没轮到的 tool call 永远拿不到对应的 toolResult。实测一批三个，第一个执行时 abort：

```
roles: user | assistant | toolResult | assistant
tool_calls in transcript : c1,c2,c3
tool results in transcript: c1
UNMATCHED tool calls     : c2,c3
```

`hasMoreToolCalls` 仍为 `true`（`terminate` 是 `false`），循环会再进一轮 `streamFn`。但此时 abort signal 已经立着，这一轮拿不到合法响应：实测第二次调用 `aborted=true`，落盘的第二条 assistant 是空的 `stopReason=aborted`，**不会**在同一次 run 里把带缺 pairing 的历史发给模型。

坏历史留在 `state.messages` 里不会自愈。用户再输入一句时，新的 AbortController 是干净的，`toOpenAIMessages` 会跳过那条空的 aborted assistant，发出去的是 3 个 `tool_calls`、1 条 tool 消息。对 OpenAI 兼容接口这是 400。`/reset` 能清掉。

`stopReason === "length"` 那条路径已经处理对了——`failToolCallsFromTruncatedMessage`（`loop.ts:226-251`）会给每个 tool call 补一条错误结果。abort 这条路径只是漏了同样的处理。

**建议方向**

abort 后给每个未执行的 tool call 补一条"已中断"的 toolResult，照 `failToolCallsFromTruncatedMessage` 的形状抄；同时该 batch 之后不应再进入下一轮 LLM 调用。

---

### 问题2 — bash 工具输出没有上限

| 项 | 值 |
|---|---|
| 位置 | `src/harness/tools/bash.ts:40`（`const chunks: Buffer[] = []`）、`bash.ts:62-63`（stdout/stderr 无条件 `push`） |
| 级别 | P1 |

**现象**

`read` 做了 2000 行 / 50KB 的截断（`read.ts:6-7`），`bash` 一点限制都没有：stdout 和 stderr 全量堆进内存数组，不截断、不限总量。模型去 `cat` 一个大日志、跑一次输出很多的命令，这段文本会原样进 transcript，下一轮整个再发给模型。

这不是默认路径就会把进程搞死，但两个工具在同一件事上的策略完全不对称。

**建议方向**

边读边截断：保留头尾各 N KB、中间插省略标记，真实字节数和是否截断放进 `details`，让模型知道"被截了、怎么拿剩下的"——`read.ts:96-111` 那套提示文案已经是现成的写法。

---

### 动手顺序建议

1. **问题1**：abort 补 toolResult，并且这一批之后不要再进下一轮 LLM。正确写法就在旁边的 `failToolCallsFromTruncatedMessage`。
2. **问题2**：bash 输出截断。小改动，和 read 对齐即可。

### 本次明确不建议做的事

- **不把「未接上」的 Harness 方法当缺陷**：`setContextWindow` / `contextUsage` / `compact` / `setThinkingLevel` / `newSession` 是占位抛错，不是漏写。
- **不做 parallel tool、不补 image 支持**：类型上有，当前 CLI 路径走不到。
- **不在这条评审里重开 Windows bash**：现象已在 `future-issues.md` No.1。
- **不为了持久化先去深拷贝每一帧事件**：现在终端渲染即时消费；若在 `message_end` 落 jsonl，拿到的是已经写完的 `finalMessage`。

---

### 复现脚本

问题1 有一个一次性脚本，放在 `test/`（该目录在 `.gitignore` 里，不进仓库）：

| 脚本 | 对应问题 | 运行 |
|---|---|---|
| `test/probe-abort-pairing.ts` | 问题1 中断后 tool call 配对缺失 | `node test/probe-abort-pairing.ts` |

用假 `StreamFn`，不打真实模型、不写项目文件，删掉即可，不需要保留。
