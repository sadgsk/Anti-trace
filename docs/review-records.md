# Review records

代码评审记录。`No.1`、`No.2`… 一个 `No.` 记一次评审，问题写在这次评审里面，从 `问题1` 往后排。

约定：

- 每条要有：**评审号、评审日期、评审模型、平台、项目版本、仓库快照、评审范围**。
- 评审结论只从**代码结构**得出，不引用评审当时之外的任何文档（README、architecture、progress 一律不看），避免被既有叙述带偏。
- 每个问题写：位置、现象、证据、建议方向。**建议方向不是定稿修法**，动手时以当时代码为准，和 `future-issues.md` 的"不写修法"原则不冲突——那份记现象，这份记判断。
- 能复现的问题附复现脚本路径。实测结果写在"证据"里，没实测的一律标 **未验证**。
- **两份文档的分工**：这份记**从代码逻辑上看得出有漏洞或有隐患**的问题——不依赖实际使用、读代码就能发现的那种；[future-issues.md](./future-issues.md) 只记**实际使用中碰到的** bug。

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

---

## No.2 — 含图工具结果的图文序列化改动自审

| 项 | 值 |
|---|---|
| 评审号 | No.2 |
| 评审日期 | 2026-09-23 |
| 评审模型 | deepseek-flash |
| 平台 | Windows（本机 `win32 10.0.26200`） |
| 项目版本 | v1.2（`package.json` `0.1.0`） |
| 仓库快照 | `main` `18fad04`（`https://github.com/sadgsk/Anti-trace.git`）。工作区含多项并行未提交改动（图片支持、上下文压缩、提示词），本次改动本身未提交 |
| 评审范围 | `src/llm/openai-chat.ts`：新增的 `toContentParts`、重写的 `toOpenAIMessages` user / toolResult 分支与 `flushToolResults` |
| 评审方式 | 5 路独立对抗性验证（顺序 / 工具连续性 / 变异有效性 / 契约 / 线格式）；13 个用例读真实请求体实测；5 个变异注入后重跑；`tsc --noEmit` |

**总体判断**

本次改动经对抗性验证未发现序列化正确性缺陷：同一次工具结果内部的图文交错保序、来源标识（toolName + toolCallId）完整、多批之间不串不重、传入的 context 不被修改、`role: "tool"` 消息始终只有字符串 content 因而不可能撑开工具应答序列。

下面两条是**读代码得出的隐患**，不是实测到的缺陷；级别 P3，**均不建议现在动**。记在这里是为了让将来改这条路径的人知道。

**问题索引**

| # | 问题 | 级别 |
|---|---|---|
| 1 | 缓存持有传入 `content` 的引用，「只读」不变式没有落在代码上 | P3 |
| 2 | 附件结束边界 `[/tool result]` 不含标识，分组靠位置，可被伪造 | P3 |

---

### 问题1 — 缓存持有传入 `content` 的引用，只读不变式没有落在代码上

| 项 | 值 |
|---|---|
| 位置 | `src/llm/openai-chat.ts:151`（`pendingToolResults.push` 的 `content: msg.content`） |
| 级别 | P3 |
| 状态 | **不是当前缺陷**（实测未修改输入）；记录为已知的隐式契约 |

**现象**

含图片的工具结果把整份 content **按引用**存进缓存，不是副本。而「缓存在手期间，里面的 content 只能读、不能写」这条不变式，**代码里没有任何地方写出来**——它只隐含在 `flushToolResults` 里 `toContentParts(result.content)` 的实现细节中（`.map` 产出新对象）。读者得自己看出来。

**证据**

- `openai-chat.ts:151` —— `content: msg.content`，无拷贝
- `openai-chat.ts:79` —— `content.push(...toContentParts(result.content))`，`toContentParts` 是 `.map`，只读
- 实测：用例 7 的输入同时命中了两个 `toContentParts` 调用点（带图的 user 消息 + 两条带图的工具结果），断言 `JSON.stringify(messages)` 转换前后相等 —— **未观察到修改输入**

**建议方向**

**不要在这一处加 copy。** 理由是 copy 只护住缓存这一个调用点，而 `toContentParts` 有**两个**调用点：

- `openai-chat.ts:79`（缓存展开）—— 加 copy 能护住
- `openai-chat.ts:103`（user 分支直接调用）—— 拿到的是 `msg.content` 本身，**无 copy 可护**

如果哪天 `toContentParts` 变成会就地写 content 的写法，走 user 分支的消息照样被污染、走工具结果的没事。**保护得不一致，反而制造「这里已经防住了」的错觉。**

要防就在 `toContentParts` 里防（一律产出新对象）。它现在用的 `.map` 本来就是这个性质，**已经在正确的层面做对了**。真正守着这条不变式的是用例 7 的断言，不是拷贝。

---

### 问题2 — 附件结束边界 `[/tool result]` 不含标识，分组靠位置

| 项 | 值 |
|---|---|
| 位置 | `src/llm/openai-chat.ts:80`（`content.push({ type: "text", text: "[/tool result]" })`） |
| 级别 | P3 |
| 状态 | 未复现于实际使用；对抗验证中有一路专门构造输入观察到可被伪造 |

**现象**

`flushToolResults` 给每份结果加结束边界，但**起始标签带标识、结束边界不带**：

- 起始：`[tool result: ${toolName} / ${toolCallId}]` —— 带标识
- 结束：`[/tool result]` —— 固定字面量

分组因此靠「标签 → 正文 → 结束边界」在 part 数组里的**相对位置**，而不是靠标识匹配。如果某份工具结果的正文里恰好包含字符串 `[/tool result]`，边界可被伪造，模型会把一组内容误读成两组。

**证据**

- `openai-chat.ts:80` —— 固定字面量，无变量
- 对抗验证中有一路构造了正文含该串的输入，观察到边界被伪造；该路自评为「现实风险极低」——需要**图片类工具**的正文里恰好出现这个精确字符串

**建议方向**

结束边界带上同一标识（例如 `[/tool result: ${toolCallId}]`），分组就从「靠位置」变成「靠标识」。是**一行**的改动。

不建议现在改：这是为假设场景加东西。等真的接了**正文不可控**的工具（把外部数据原样回填的那类）再决定。目前会返回图片的工具（`read` / 截图类）正文都是自己生成的，撞不上。

---

### 本次验证已通过（备查）

改这条路径时下列性质应继续保持，用例文件 `test/tool-result-images.test.ts`（13 例）：

1. 同一批多个工具带图时，`assistant(tool_calls)` 后紧邻的 tool 消息数量与 id 一一对应，附件落在整批之后
2. 同一次工具结果内部的图文交错顺序原样保留
3. 带图结果后面纯文字结果不被 user 消息挤开
4. 图片-only / 文字-only / 空结果 三种形态各自正确，不生成空附件
5. 历史以 toolResult 结尾时仍 flush；后面有真实 user 时附件在其之前
6. 两批工具各自成组，不串批、不重复
7. 普通 user 消息的图文交错保序；转换不修改输入且重复转换结果一致

变异注入实测（5 个变异全部被上述用例抓到）：重复携带正文、删除结束边界、标签丢 toolCallId、删除附件开头说明、指引缩到只剩 ID。

---

## No.3 — 上下文溢出恢复时错误可能提前显示

| 项 | 值 |
|---|---|
| 评审号 | No.3 |
| 评审日期 | 2026-09-25 |
| 评审模型 | Codex（GPT-6） |
| 平台 | Windows |
| 项目版本 | v1.2（`package.json` `0.1.0`） |
| 仓库快照 | `main` `c045a68`，上下文压缩代码在未提交的工作区改动中 |
| 评审范围 | `src/agent/agent.ts`、`src/harness/harness.ts`、`src/cli/main.ts`、`src/cli/render.ts` 的错误事件与压缩重试流程 |
| 评审方式 | 阅读当前源码；未在真实 REPL 中复现显示顺序 |

### 问题1 — 可恢复的上下文错误可能先于重试回复显示

| 项 | 值 |
|---|---|
| 位置 | `src/cli/main.ts` 的 `harness.subscribe(renderEvent)`；`src/cli/render.ts` 的 `agent_end` 分支；`src/harness/harness.ts` 的 `prompt()` |
| 级别 | P2 |
| 状态 | **代码路径可推导，终端显示未实测** |

**现象与证据**

首次请求因上下文溢出返回 `error` 时，Agent 会先发出 `agent_end`。CLI 订阅了这些事件，`renderEvent()` 遇到失败的 assistant 就立即打印 `errorMessage`。随后 `Harness.prompt()` 才检查最后一条消息、压缩上下文并调用 `continueFromContext()` 重试。因此，如果重试成功，终端仍可能先出现“上下文过长”的错误，再出现成功回复，让用户误以为本轮失败。当前假 `StreamFn` 验证了压缩与重试流程，但没有验证终端输出顺序。

**建议方向**

在确认恢复结果后决定是否显示这条错误；如果压缩或重试失败，仍应显示最终错误。修改时需核对事件订阅者的行为，避免只隐藏 CLI 文案却让其他订阅者收到含义不明的中间失败事件。

---

## No.4 — 提交时图片位置丢失，模型无法知道图片在 prompt 的哪一处

| 项 | 值 |
|---|---|
| 评审号 | No.4 |
| 评审日期 | 2026-10-08 |
| 评审模型 | Claude |
| 平台 | Windows |
| 项目版本 | v1.2（`package.json` `0.1.0`） |
| 仓库快照 | `main` `8506419`，工作区干净 |
| 评审范围 | `src/cli/input/prompt-draft.ts` 的 `preparePromptSubmission()`；`src/cli/input/prompt-input-controller.ts` 的图片引用创建；`src/harness/harness.ts::prompt()`；`src/llm/openai-chat.ts` 的图片序列化。对照本地 `claude-code-rev` 的 `src/history.ts::expandPastedTextRefs()`、`src/utils/processUserInput/processTextPrompt.ts` |
| 评审方式 | 通读当前源码并与本地 `claude-code-rev` 逐处对照；未调用真实模型验证模型实际响应 |

**总体判断**

这是一处**行为保真度**的限制，不是崩溃或多数路径出错：图片字节流照常发给模型，模型能看到图片内容，只是**看不到图片在文本中的位置**。级别 P3，记录备查。

**问题1 — 图片占位符在提交时被整段删除，位置信息不进请求**

| 项 | 值 |
|---|---|
| 位置 | `src/cli/input/prompt-draft.ts:60-66`（`preparePromptSubmission` 的循环）；`src/harness/harness.ts:94-100`（`runPrompt` 组装文本）；`src/llm/openai-chat.ts:36`（图片转 data URL 块） |
| 级别 | P3 |
| 状态 | **代码路径可推导，模型侧未实测** |

**现象**

`preparePromptSubmission` 按引用逐段拼接最终文本：文本引用（`[Pasted text #N]`）用原文 `content.text` 顶替，图片引用（`[Image #N]`）只把图片收进 `images` 数组、对应的占位符区间**不产出任何文本**（`offset = ref.end` 直接跳过）。因此提交后的文本里不会出现图片占位符，图片只以“独立块 + 先后顺序”进入请求。记录占位符精确位置的 `references`（含 `start`/`end`/`label`）是编辑器的内部数据，随提交一起丢弃，不会再往下传。

结果是：模型能知道“这条消息里有几张图、它们的先后顺序”，但**无法判断某张图原来夹在哪段文字之间、属于哪个粘贴块**。例如 `"开头 [Pasted text #1] 中间 [Image #2] 结尾"` 提交后，模型看到的文本是“开头 + 粘贴块1原文 + 中间 + 结尾”（图片位置变成空），图片另成一块，图与文字的相邻关系丢失。

**证据**

- `prompt-draft.ts:63`（文本引用展开 `parts.push(content.text)`）与 `prompt-draft.ts:64`（图片只 `images.push(...)`，文本分支不产出）形成不对称：文本保留内容、图片只留顺序。
- `harness.ts:100` —— `await this.agent.prompt(promptText, images)`，文本与图片作为两个并列参数下传，文本中无位置标记。
- `openai-chat.ts:36` —— 图片被序列化为 `data:${mimeType};base64,...` 块，不带任何指向文本位置的标识。
- 对照 `claude-code-rev/src/history.ts:79`（`expandPastedTextRefs` 注释：`Image refs are left alone — they become content blocks, not inlined text`）与 `processTextPrompt.ts:75-76`（`content: [...textContent, ...imageContentBlocks]`）：CC 的文本里**保留** `[Image #N]` 字面量，模型据此能看到图片在文本中的位置。本项目删掉了该字面量，位置随之丢失。
- **未验证**：未调用真实模型确认其是否真的“无法推断位置”；结论由代码路径直接得出。

**建议方向**

若要让模型知道图片位置，可选其一：① 提交时**不删**图片占位符，保留 `[Image #N]` 字面量随文本一起发（对齐 CC 的做法）；② 把占位符替换成可读的位置标记。两条都会改变发给模型的文本形态，需同时确认是否影响命令解析（单行斜杠命令判断）与压缩摘要。当前 `references` 只服务编辑器内部（原子编辑、提交展开），**不发送给模型**，因此无法靠它补位置信息。

---

## No.5 — 默认模型或选中模型不在列表时 CLI 直接退出

| 项 | 值 |
|---|---|
| 评审号 | No.5 |
| 评审日期 | 2026-10-15 |
| 评审模型 | Codex（GPT-6） |
| 平台 | macOS（`darwin arm64`），Node `v24.15.0`；问题由公共启动逻辑引出，其他平台未实测 |
| 项目版本 | v1.2（`package.json` `0.1.0`） |
| 仓库快照 | `main` `4791d08`，记录前工作区干净 |
| 评审范围 | `src/config/byok.ts::loadByokConfig()` 的默认／本次模型选择校验；`src/cli/main.ts::runCli()` 与直接运行入口的错误处理 |
| 评审方式 | 与用户阅读当前源码，按调用顺序检查错误传播；未运行 CLI 复现，不读取真实凭据、不调用模型 |

### 问题1 — 模型引用失效被当作终止 CLI 启动的错误

| 项 | 值 |
|---|---|
| 位置 | `src/config/byok.ts:119-121`；`src/cli/main.ts:33`、`src/cli/main.ts:43-45`、`src/cli/main.ts:108-110` |
| 级别 | P2 |
| 状态 | **待修；代码路径可推导，CLI 行为未实测** |

**现象**

- JSON 中保存的 `config.currentModel` 不在模型列表中时，加载器立即抛错；即使 `options.model` 指定了列表中存在的模型，也会被前面的默认模型校验阻断。
- 默认模型有效、但 `options.model` 指定的模型不在列表中时，加载器同样抛错。
- 配置加载发生在终端交互界面启动之前。错误传到直接运行入口后，只打印提示并设置退出码 `1`，本次 CLI 启动结束，用户无法留在 CLI 内重新选择模型。

这里的实际行为是捕获错误后退出，不是未捕获异常；问题在于可由用户重新选择解决的配置问题，导致整个 CLI 启动终止。

**证据**

- `src/config/byok.ts:119`：检查保存的默认模型，不存在就 `throw`，执行顺序早于 `options.model ?? config.currentModel`。
- `src/config/byok.ts:120-121`：确定本次选择后再次检查模型是否存在，不存在仍直接 `throw`。
- `src/cli/main.ts:33`：`runCli()` 先调用 `loadByokConfig()`，没有在此处恢复到可选择模型的状态；终端界面要到 `src/cli/main.ts:43-45` 才启动。
- `src/cli/main.ts:108-110`：外层 `.catch()` 打印错误，并将 `process.exitCode` 设为 `1`。
- **未验证**：未执行缺失默认模型／本次选择的 CLI 复现，以上结论来自当前源码路径。

**预期行为（用户确认）**

默认模型或本次选中的模型不在模型列表中时，应提示用户，保持 CLI 可操作并允许重新选择有效模型，不应因此终止整个程序。默认模型失效、但本次明确指定了有效模型时，也不应仅因默认项失效而阻止使用该有效选择。

**建议方向**

将模型引用失效的提示与进程退出解耦，在 CLI 中保留重新选择／修正配置的入口；尚无有效模型时，不继续发起聊天请求。具体错误返回方式和界面流程在修复时结合当时代码确定。本次只记录问题，不修改实现。
