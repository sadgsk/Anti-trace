# 关键认知（Key points）

**用途**：阅读源码过程中形成的、经过验证的项目认知。每条记录一个"看代码时容易误解、但结论确定"的点，写清楚**事实、原因、代码位置、验证方式**。不做设计决策记录（那是 [architecture.md](./architecture.md)），不记待办（那是 [progress.md](./progress.md) / [future-issues.md](./future-issues.md)）。

**写法约定**

- 一条一个主题，编号 `KP-1`、`KP-2`… 往后加，不复用编号。
- 每条必须包含：**结论**（一句话）、**原因**（为什么是这样）、**代码位置**（`文件:行号`，行号以记录时的提交为准）、**验证方式**（怎么自己确认，不要只写"我认为"）。
- 有实测数据的，写明**测量方法、协议、日期**。数据是启发式估算的要标出来，不要当成 API 返回值。
- 结论只写**当前成立**的。如果依赖 provider 行为而非代码，必须在结论里写明"这条不在本项目可控范围内"。

---

## KP-1 — `tools` 是请求顶层字段，不在 messages 里，每次请求重发

**结论**

工具定义（`name` / `description` / `parameters`）是**请求体的顶层字段**，与 `messages` 平级、独立。它既不追加进对话历史，也不依附某条 user 消息。**每一个 HTTP 请求都携带一份完整的工具定义**；即使只有一轮用户输入，只要中间发生工具调用，就会有多次请求，每次各带一份。

**原因**

HTTP 无状态，服务端不记忆上一轮的工具列表，客户端也不做任何"只发一次"的优化。`streamAssistantResponse` 在一次请求前把 `Context` 整个重建，`tools` 原样带上；adapter 再把它序列化进 body。

**代码位置**

| 环节 | 位置 |
|---|---|
| 工具定义来源 | `src/harness/tools/{read,bash,edit,write}.ts`（`name`/`description`/`parameters`） |
| 装配进初始状态 | `src/harness/harness.ts:97`（`buildSystemPrompt` 同处） |
| 构造请求级 Context | `src/agent/loop.ts:163`–`168`（`systemPrompt` / `messages` / `tools` 每轮重建） |
| 每轮循环 | `src/agent/loop.ts:63`（`while (true)`，每次工具调用后再请求一次） |
| anthropic 序列化 | `src/llm/anthropic.ts:81` → `{name, description, input_schema}` |
| openai-completions 序列化 | `src/llm/openai-chat.ts:265` → `{type:"function", function:{name, description, parameters}}` |
| openai-responses 序列化 | `src/llm/openai-responses.ts:84` → `{type:"function", name, description, parameters, strict:false}` |

**两个"tool"必须区分开**

| | ① 工具定义 | ② 工具调用历史 |
|---|---|---|
| 载体 | body 顶层 `tools` | `messages` 数组内部的 `toolCall` / `toolResult` |
| 数量 | 恒定 4 个 | 随对话累积增长 |
| 生命周期 | 每次请求一份，内容字节级相同 | 一条条堆在历史里 |
| 代码 | `loop.ts:167` | 结果消息构造 `loop.ts:548`（`createToolResultMessage`）；落进历史 `loop.ts:108`–`111` |

**验证方式**

用真实 `Agent` + 真实工具 + mock `streamFn` 跑两轮（第一轮含一次 `read` 调用），记录每次 `streamFn` 收到的 `context`：

```
turn 1 / 第 1 次请求: messages=1, tools=4
turn 1 / 第 2 次请求: messages=3, tools=4   ← 工具续接
turn 2 / 第 1 次请求: messages=5, tools=4   ← 历史增长，tools 不变
```

---

## KP-2 — JSON 里的字段顺序 ≠ prompt 里的字段顺序

**结论**

`tools` 在请求 JSON 里出现在哪个位置**完全不影响模型输入和缓存**。它在 JSON 文本里排在末尾（`anthropic.ts:79`–`81` 的插入顺序导致），但在 provider 渲染出的 prompt 里固定排在最前面。**这不是客户端做的重排**，客户端没有能力也没有必要重排。本项目可控的只有"有哪些工具、system 是什么、messages 顺序"。

**原因**

一次请求经过五层，缓存只看最后一层：

```
① 你的 JS 对象        { model, messages, system, tools }
      ↓ JSON.stringify()      key 顺序 = 插入顺序，无语义
② 字节流              "{\"model\":...,\"tools\":[...]}"
      ↓ HTTP
③ provider 反序列化    { messages:[...], tools:[...] }   按 key 名取值，顺序丢弃
      ↓ 各自的 prompt 模板渲染
④ prompt token 序列    [TOOLS][SYSTEM][MSG0][MSG1]...
      ↓ 与上一次请求比最长公共 token 前缀
⑤ 缓存命中判定
```

关键在第 ③ 层：按 JSON 规范，object 是**无序键值集合**，`{"tools":…,"messages":…}` 与 `{"messages":…,"tools":…}` 反序列化后结构完全相同。顺序信息在进入 ④ 之前就已经消失，所以它既不能"破坏"什么，也不能"促成"什么。

第 ④ 层的顺序由**接收方**决定，不是协议保证：

- Anthropic 文档明确顺序为 `tools → system → messages`。
- OpenAI 由各自 API 的序列化逻辑决定，未在文档中承诺顺序。
- 开源自托管（vLLM / llama.cpp / SGLang）时，顺序明写在模型目录的 Jinja chat template 里（`{% if tools %}` 段落落在 system 之前还是之后由该文件决定）。

所以准确表述是：**"工具在前"是某些 provider 的实现选择，不是通用规律；唯一稳定成立的是"你无法控制它"。**

**唯一的反例（会真的坏缓存）**

部分自建网关 / 反向代理**不解析 body，直接对 raw body 做哈希**当缓存 key。这类实现下 JSON 字节顺序、字段增删都会导致 miss。`compaction.ts:100` 的注释特意写 "byte-identical prefix" 而不是 "token-identical"，防的就是这类网关。

**验证方式**

把 `anthropic.ts:79`–`81` 里 `body.tools = …` 挪到 `body.messages` 之前，重跑同样的对话：dump 出的 JSON 顺序变了，但 token 数、模型输入、缓存命中率不变。

---

## KP-3 — 把 `tools` 放在 prompt 最前，是缓存设计的前提

**结论**

`tools + system` 是每请求**字节级不变**的前缀，因此是 prompt cache 的最佳断点。这解释了为什么它们必须排在最前：前缀一旦变动，整段缓存失效。反过来，如果 `tools` 跟着最新 user 消息放到最后，前缀每轮都变，缓存归零 —— 所以任何实现都不会这么放。

**原因**

prompt cache 的命中条件是**最长公共前缀相等**。稳定内容放在越前面，命中的部分越多。本项目 tools 约占总 context 的 **85%**（见 KP-5 实测），不缓存的话等于每轮重复全额支付这部分。

**代码位置**

| 事实 | 位置 |
|---|---|
| tools 参与"请求指纹"，说明作者把它视为请求级不变量 | `src/harness/harness.ts:227`–`229`（`requestKey = JSON.stringify([model, systemPrompt, tools 的 name/description/parameters])`） |
| 上下文估算把 tools 当**固定开销**单独计入 | `src/harness/context.ts:8` |
| 摘要请求刻意复用同一前缀以吃缓存 | `src/harness/compaction.ts:100`–`106` |
| 摘要请求因此也带全套工具，模型可能误回 tool call，需重试 | `src/harness/compaction.ts:300`（调用 `isToolCallReply` 重试）、`compaction.ts:246`（判定）、`compaction.ts:110`（`NO_TOOLS_PREAMBLE` 强指令压制） |

**已知缺口（本项目当前状态，非 bug 记录）**

`anthropic.ts:105`–`110` 只**读取**了 `cache_read_input_tokens` / `cache_creation_input_tokens` 用于上下文计量，但请求侧**没有插入 `cache_control` 断点**。也就是说走 Anthropic 官方端点时，`tools + system` 这段稳定前缀目前拿不到显式缓存折扣；OpenAI / DeepSeek 侧的自动前缀缓存不受影响（项目注释实测该网关命中 ~97%、与 miss 有 50x 价差，见 `compaction.ts:102`–`104`）。

**验证方式**

对比两次相同历史的请求的 `usage.cache_read_input_tokens`：自动缓存网关应出现稳定的非零命中；Anthropic 官方端点由于没有断点，命中面积取决于 provider 的默认行为，需实测确认。

---

## KP-4 — adapter 在 wire 边界丢弃大量内部字段

**结论**

`AgentContext` 里的很多字段**只服务 UI 与内部逻辑，不出网、不占 token**：`details`（工具结果元数据）、`label`（工具显示名）、`timestamp`、`usage`、`stopReason`、`model`。adapter 只挑选协议需要的部分。

**原因**

adapter 的职责就是"内部结构 → 协议结构"的投影，并且顺手把每次都会变的字段（`timestamp`、`usage`）挡在 wire 之外 —— 这本身也是缓存友好的：变字段不进前缀。

**代码位置**

- `src/llm/anthropic.ts:79`–`81`：只取 `tool.name` / `tool.description` / `tool.parameters`→`input_schema`；message 侧只保留 `content`、`tool_use{id,name,input}`、`tool_result{tool_use_id,is_error,content}`。
- `src/llm/openai-chat.ts:99`–`177`：`system` 作 `messages[0]`、`toolCall`→`assistant.tool_calls`、`toolResult`→`role:"tool"`；含图片的工具结果会被拆到批次之后的 user 附件消息（`openai-chat.ts:70`–`97`）。
- `src/llm/openai-responses.ts:84`：`tools` 平铺为 `{type:"function", …}`，system 走 `body.instructions`（`openai-responses.ts:81`）。

**验证方式**

同一份 `AgentContext` 分别喂三个 adapter，mock `fetch` 后对比 body：`details` / `timestamp` / `usage` 均不出现。

---

## KP-5 — 实测数据：tools 占整个 context 的绝大部分

**测量方法**：真实 `Agent` + 真实 `buildSystemPrompt` + 真实 4 个工具；`streamFn` 与 `fetch` 打桩；协议 `anthropic-messages` + `preset: deepseek`；两轮对话，第一轮含一次 `read`（读一个 9 行 `package.json`）。token 用 `estimateContextTokens`（`src/harness/context.ts:6`，**chars/4 启发式估算，不是 API 返回的 usage**）。

**测量日期**：2026-11-09，提交 `56edf8e`。

| 部分 | 估算 token | 占比 |
|---|---|---|
| tools schema（4 个） | 695 | ~85% |
| messages（5 条，含一次工具往返） | 275 | ~34% |
| systemPrompt | 77 | ~9% |
| **整个 context** | **819** | — |

（三行之和大于总数，因为 `estimateContextTokens` 对 messages 与 system/tools 的口径不同，此处只用于看量级。）

**可用于决策的结论**

1. 想省 token，**优化工具 schema 的收益远大于改 system prompt**。合并工具、精简 `description` 比删 system prompt 里的几句话有效一个数量级。
2. system prompt 短（`src/harness/prompt.ts`，约 77 token）**不是问题**，工具定义才是主要固定开销。
3. 4 个工具的 schema 每请求都在，且由于是稳定前缀，是缓存收益最大的一块 —— 这也是 KP-3 的动力。

---

## 待补充（自己看代码时发现的点，按需加 KP-6、KP-7…）

- [ ] `beforeModelRequest` 与压缩的交互（`harness.ts:222`–`242`）：什么时候会在请求前改动 context、什么时候返回 `undefined` 放过。
- [ ] `transformContext` / `convertToLlm` 两个钩子的分工（`loop.ts:158`–`163`）。
- [ ] 思考内容（thinking）回传规则：`rules.reasoningReplay` 三种模式在续接时会抛错的条件。
