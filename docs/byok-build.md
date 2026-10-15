# BYOK build：按小批次接入模型与思考控制

状态：**第 01 批已通过用户 review；第 02 批配置加载与启动选择已实现，用户已授权提交推送，`byok.ts` 主体留待 Mac 继续 review。规则编码与三协议完整能力尚未接通**。更新：2026-10-15。

这份文档用于后续模型带着用户逐步开发。先读 [progress.md](./progress.md) 的当前状态和协作约定，再按本文件选择当前小批次。不要把整份文档当成一次性实施指令。

## 1. 如何带着做

每次只推进一个用户能看完、能理解的小批次：

1. 动手前说明本批目标、主流程函数的输入／处理／输出、参考源码和配套改动。
2. 阅读当前代码后再定实际文件和函数名；不要因为本文给了建议名就重复搭框架。
3. 写入本批必要代码，解释主流程怎样调用配套函数。用户不用手动粘贴。
4. 功能完整后再做对应行为验证；类型与构建检查按项目约定进行。不要在功能做到一半时插入探针。
5. 交代改动、验证结果和未覆盖项，更新本批状态，**停下等待用户 review**，确认后再进入下一批。

**尽量按最终结构交付完整功能点：** 每步实现时，尽量让当前功能点直接采用整个 BYOK 功能完成后仍会保留的结构和行为。避免为了本批临时能用而加入过渡类型、临时接线、假实现或短期分支，后续又大改，导致用户已理解的代码失去作用。后续开发应主要补齐周边能力、扩展已有实现；可以预留明确的最终接口，但不把临时替代品当作功能完成。

本文中的功能分块表示职责，不要求实现成同样数量的服务、类或流水线。批次顺序、辅助函数和文件划分可以根据实际代码调整；提前说明理由并同步文档。**如果一个小功能与其他功能依赖紧密，单独交付需要大量过渡代码，就扩大本批范围，合并相邻步骤，一次完成一个完整功能后再 review。** 不为严格遵守批次编号而硬拆，也不把扩大单批范围理解成一次实施整份路线。未获新的实现授权时，文档中的待办不代表可以自行开始改代码。

## 2. 已确定的产品行为

- 用户使用固定五档：`low / medium / high / xhigh / max`，另有独立的思考开关。
- 五档和开关的事件／接口不随模型变化。主页不灰掉档位，也不显示“仅支持思考开关”之类的能力提示。
- 原生档位较少时，按原生强度从低到高依次映射，剩余本地档位重复最高档。名称不必逐字相同。
- 仅支持开关的模型，五档都映射成同一个开启结果。
- 使用数字预算的模型，五档直接查五档预算表；不要先把本地档位压成三档原生 effort，再查预算。
- 关闭思考独立处理，不能把关闭映射成 `low`，也不能把隐藏思考输出当成关闭。
- 关闭后仍保存选中的档位；再次开启或切换模型时，按当前模型规则重新解析。
- 协议限定为 OpenAI Chat Completions、OpenAI Responses、Anthropic Messages。Gemini 如接入，先使用其兼容接口，本轮不新增 Gemini 原生协议。
- 以新版 Kimi Code 的统一请求边界为参考，结合 CC Switch 的规则、映射和兼容处理；不全盘搬运任何一方。
- 上层只调用一个适配器入口。思考映射、接口兼容、请求组装和流式解析集中在适配器模块内部，以小函数和配置表组织。
- 规则优先覆盖一手 LLM 厂商。聚合商和套餐网关次级考虑，不为 Command Code、OpenCode Go 等逐个建设专用分支。

第 01 批已将 `ThinkingLevel` 改成固定五档，Agent 使用 `thinking: { enabled?, effort }` 保存偏好。`enabled` 未指定表示保留服务端默认，不发送档位控制；初始保存档位为 `medium`。明确开启／关闭时仍保留选中档位。线上字段编码及 CLI 控制尚未实现，当前 Chat 适配器对明确开关返回“未实现”，不声称已经生效。

## 3. 参考仓库与阅读入口

### 3.1 使用新版 TypeScript Kimi Code

本地参考：`E:\pi-harness\kimi-code`，与 `cli-agent`、`pi`、`claude-code-rev` 同级。它是从 `E:\kimi-code` 创建的独立 Git 参考副本，原目录保留；没有安装依赖或修改参考源码。

- 官方仓库：[MoonshotAI/kimi-code](https://github.com/MoonshotAI/kimi-code)。这是 TypeScript monorepo，不是旧 Python `MoonshotAI/kimi-cli`。
- 固定参考提交：`be7d5f5fea7800778e4660cd5f36780ba783bddd`，2026-09-24；CLI 包 `apps/kimi-code/package.json` 版本 `2.1.1`，对应当次检查的最新发布版。
- 当次远端 main 为 `c9f01f07388abc2cdca40c9c5267f58c65086710`，2026-10-10。本文使用本地固定快照，不声称它等于远端最新 main；升级参考时重新核对函数与规则。

此前讨论中的 Python `with_thinking`、`llm.py` 等路径属于旧实现。后续主要依据下面这些 **TS 文件和实际调用链**，不要继续把旧路径当作新版施工入口。

| 要看什么 | 新版 TS 本地路径与函数 | 借鉴点 |
|---|---|---|
| 模型和连接配置 | `packages/agent-core-v2/src/app/kosongConfig/configSection.ts`：`ProvidersSectionSchema`、`ModelRecordSchema`、`ThinkingConfigSchema` | 连接、模型能力、思考偏好分别保存；用户可覆盖模型元数据 |
| 协议粗分类 | `packages/agent-core-v2/src/human/llm/provider/definition.ts`：`ProtocolBinding`、`createProvider()`；同目录 `providers/standard.ts` | 一个厂商条目引用共用协议 base，可选 trait；并非每家完整复制请求代码 |
| 统一请求边界 | `packages/agent-core-v2/src/human/llm/requester/requester.ts`：`LlmRequestConfig`、`LlmRequester`；`src/llm-adapter/model/model-requester-impl.ts`：`ModelRequesterImpl` | 统一模型、消息、工具、思考、取消和响应事件的边界 |
| 思考语义与校验 | `packages/agent-core-v2/src/human/llm/thinking.ts`：`resolveThinkingEffort()`、`resolveThinkingEffortForModel()` | 区分开关、实际 effort、默认值及无法关闭；不照搬其动态档位 UI |
| 共用编码与特殊规则 | `packages/agent-core-v2/src/human/llm/protocol/thinking.ts`：`applyThinking()` | 先使用接口特殊策略，没有贡献时使用协议默认编码 |
| Chat 请求准备 | `packages/agent-core-v2/src/human/llm/requester/bases/openai/requester.ts`：`prepareOpenAIRequest()`；同目录 `format.ts`、`lower.ts` | 思考字段、消息、工具、请求参数和流事件转换 |
| Responses 请求准备 | `packages/agent-core-v2/src/human/llm/requester/bases/openai-responses/requester.ts`：`prepareOpenAIResponsesRequest()`；`format.ts`：`normalizeOpenAIResponsesReasoning()` | 请求结构、reasoning items 和工具往返 |
| Anthropic 模型规则 | `packages/agent-core-v2/src/human/llm/requester/bases/anthropic/profile.ts`：`resolveThinkingProfile()`、`encodeThinking()` | 自适应／预算模式、关闭、原生 effort 与输出限制 |
| Anthropic 请求准备 | 同目录 `requester.ts`：`prepareAnthropicRequest()`；`format.ts`：`lowerAnthropicMessages()`、`createAnthropicFormat()` | 参数组合、工具与签名、流式内容块的处理 |

表中路径均相对于 `../kimi-code`。`packages/kosong/src/provider.ts` 及 `providers/*.ts` 也可辅助阅读，但不要把旧 Kosong 路径和 agent-core-v2 当前请求链混为一条链。

新版 TS 本身有 base、trait、模型元数据等内部拆分，并不是所有逻辑塞进一个函数。本项目借鉴统一入口、协议复用和兼容策略，不搬入它的 DI、Scope、模型目录服务和完整注册系统。对 Agent 仍只有一个适配器入口。

### 3.2 CC Switch：借规则，不搬整个代理

参考固定为 [CC Switch v4.0.9](https://github.com/farion1231/cc-switch/tree/v4.0.9)，提交 `8845b1ef799aa8810b864b122de6af5f4629de10`。后续可按需阅读这些链接，无需使用之前调研的临时目录。

| 部分 | 源码与定位 | 本项目用途 |
|---|---|---|
| effort → Anthropic 预算 | [`transform_codex_anthropic.rs`](https://github.com/farion1231/cc-switch/blob/v4.0.9/src-tauri/src/proxy/providers/transform_codex_anthropic.rs)：`effort_to_thinking_budget()`、`responses_request_to_anthropic()` | 预算查表、自适应／预算分流、回答空间预留 |
| Claude 请求 → OpenAI effort | [`transform.rs`](https://github.com/farion1231/cc-switch/blob/v4.0.9/src-tauri/src/proxy/providers/transform.rs)：`supports_reasoning_effort()`、`resolve_reasoning_effort()`、`clamp_reasoning_effort_for_model()` | 已知模型 effort 支持与修正思路；本项目不解析来自 Claude Code 的代理请求 |
| Responses 字段编码 | [`transform_responses.rs`](https://github.com/farion1231/cc-switch/blob/v4.0.9/src-tauri/src/proxy/providers/transform_responses.rs) | `reasoning.effort` 和响应格式参考 |
| 可复用等级表 | [`piThinkingProfiles.ts`](https://github.com/farion1231/cc-switch/blob/v4.0.9/src/config/piThinkingProfiles.ts)：`piThinkingProfiles`、`piThinkingBindings`、`resolvePiThinkingProfile()` | 分离规则表与模型／协议绑定；借鉴原生档位，改成我们的五档映射策略 |
| 接口格式差异 | [`piProviderPresets.ts`](https://github.com/farion1231/cc-switch/blob/v4.0.9/src/config/piProviderPresets.ts)：`DEEPSEEK_THINKING_COMPAT`、`QWEN_THINKING_COMPAT` 等 | 识别同一协议下的思考字段及历史回传差异 |
| 官方端点特例 | [`claude.rs`](https://github.com/farion1231/cc-switch/blob/v4.0.9/src-tauri/src/proxy/providers/claude.rs)：`normalize_deepseek_thinking_disabled_strip_effort()` | 关闭时清理冲突字段，按具体接口生效 |
| 模型识别与预算修正 | [`thinking_optimizer.rs`](https://github.com/farion1231/cc-switch/blob/v4.0.9/src-tauri/src/proxy/thinking_optimizer.rs)、[`thinking_budget_rectifier.rs`](https://github.com/farion1231/cc-switch/blob/v4.0.9/src-tauri/src/proxy/thinking_budget_rectifier.rs) | 阅读模型分类与预算约束，不照搬自动改强度／关闭设置的行为 |

CC Switch 的多家预设不是“所有模型参数都已知”的证明。其某些模型表与最新官方文档已有差异，导入时逐项核对。使用方式是抽取本批需要的纯映射／兼容逻辑，注明版本和来源，不复制整个代理、跨协议加密封装、OAuth 体系或所有预设。实际复制代码时核对来源许可并保留必要声明。

特别不照搬：关闭降成 `low`、预算不足时悄悄关闭思考、优化器把用户关闭改成开启，以及把 UI 未支持档位标成不可用。CC Switch 的预算表将 `xhigh` 与 `max` 合并；我们的公共预算表应有五个递增值。

## 4. 从当前代码开始

| 现状 | 施工时需要补什么 |
|---|---|
| `runCli()` 已通过唯一入口 `loadByokConfig()` 加载 JSON 目录和启动模型，缺文件时报错 | 后续增加运行中模型选择；当前仍直接使用 Chat，另两种协议启动时明确未实现 |
| 第 01 批定义三协议和模型能力；第 02 批已加载上下文／输出设置与 `endpoint?` | 补模型规则及协议实现；能配置协议不表示该协议已经可运行 |
| `StreamOptions.thinking` 已接收统一偏好 | 补实际映射、字段编码与请求校验，不把厂商 JSON 字段传入 Agent |
| `ThinkingContent.replay` 已预留来源与完整 JSON payload | 补协议流式组装、合法签名／opaque 数据回传和跨来源处理；目前只验证已有 JSONL 能保留这些数据 |
| `Agent.createLoopConfig()` 已复制模型和偏好，loop 已传递并应用显式 hook 更新 | 后续补设置入口、busy 门槛和动态凭据；普通 state 变更不污染本轮工具续接，内部 hook 可明确覆盖下一次请求 |
| `Harness.setThinkingLevel()` 抛“未接上” | 改成可用的独立开关与档位设置入口 |
| 只有 `streamOpenAIChat()` | 在同一 `StreamFn` 边界上补齐 Responses、Anthropic，保留已有 Chat 图文／工具行为 |
| 普通请求可调用 `getApiKey`，压缩直接读 `agent.apiKey` | 统一当前模型的凭据与请求设置来源，避免主对话可用但 `/compact` 失败 |
| JSONL 只有消息和压缩条目 | 消息保留回传元数据；按需要增补模型／思考选择记录，并兼容旧会话 |
| REPL 只呈现文字，命令不含模型和思考选择 | 补选择入口和 thinking 事件显示；不重写当前输入编辑器 |

已有线性会话、工具执行、取消和压缩继续复用。已知独立问题留在 [future-issues.md](./future-issues.md)，不要顺手扩大本轮范围；如确实阻碍协议验收，当场说明并安排独立小批。

## 5. 功能分工：外部一个入口，内部保留粗分类

### A. 配置与模型规则

保存连接信息、模型能力、当前模型与思考偏好；将预设和用户覆盖整理成当前可用模型配置。优先用简单列表／字典，不建设多级规则树。

连接至少包含 URL、凭据、协议；模型至少包含上游 model ID、显示名、上下文窗口、最大输出设置及必要能力。可复用同一个连接配置保存多个模型。

第 02 批已采用项目 cwd 下的 `byok.json`，字段与查找顺序见 §6.1；不增加多目录继承。凭据默认直接填写在本机 JSON，也可明确引用进程环境变量；不读取 `.env` 文件。读取函数与模型目录分开，日志与 session 不写 key 或鉴权头，本机配置被 Git 忽略。

URL 的输入约定也在配置批次讲清：base URL 与完整推理 endpoint 必须能区分，避免重复拼接 `/v1` 或请求路径。推理地址不自动当作模型信息查询地址，不依靠 ping 推断思考档位。

### B. Provider Adapter

Agent 仍通过 `StreamFn(model, context, options)` 一类入口发请求。适配器内部负责选择规则、思考映射、参数校验、消息／工具序列化、鉴权、HTTP 与流解析。

粗分类是三种协议，不是一家厂商一个分类：

| 新接入情况 | 通常需要的改动 |
|---|---|
| 协议与字段相同，只有原生档位不同 | 新增模型规则／等级表，不改 controller 分流 |
| 协议与思考方式相同，只换 URL、key、model | 新增连接／预设数据，不新增适配器 |
| 新的思考字段、关闭编码、输出参数或鉴权要求 | 增加一个小的兼容规则，由同类接口共用 |
| 历史消息／响应流有差异 | 在对应协议内补消息或解析兼容函数，不复制整套协议 |
| 全新的协议 | 另行评估，不纳入当前三协议里程碑 |

三协议选择可以是一个小 factory 或 switch。接口编码可以由配置指定 `thinkingFormat` 一类标识；相同标识共用实现。不要每新增厂商就加一个完整 controller 类或一条长分支。

思考映射和字段编码在**同一适配器模块内保持职责清楚**：前者决定实际值，后者决定字段位置。辅助函数可同文件或单独存放；不暴露多层 ThinkingResolver／Router 服务给 Agent。

### C. Agent、Harness 与会话

Agent 保存用户意图，Harness 管理模型切换、凭据和会话。开始一轮时快照模型、规则、开关和档位；本轮的工具后续请求继续使用这份设置。v1.2 可在 busy 时拒绝切换，不必先实现复杂的运行中热切换。

第 01 批保留已有内部 `prepareNextTurn` hook 的显式请求覆盖能力：它可以返回下一次请求的 `model` 和／或完整 `thinking` 偏好，返回的对象会复制，未返回的设置继续沿用。该覆盖只影响当前 loop，不自动改写用户偏好；普通 UI／state 变更仍在下一次运行读取。静态 API key 随运行配置保存，动态 `getApiKey` 目前仍按每次请求调用；统一动态凭据与 busy 入口在第 10／11 批完成。

压缩和普通请求走同一适配器入口、凭据获取路径及当前规则。压缩可降低总输出上限，但同时重新校验思考预算，不能直接复用一份不满足输出限制的请求体。

### D. CLI 与验证

现有 REPL 增加模型选择、思考开关和五档入口。v1.2 可以先用配置文件和命令；选择器、快捷键或配置对话框的呈现按当批确定，不提前重做 v1.3 的完整 TUI。

主页只暴露既定的两个思考控制。必要的未知接口修正在 BYOK 配置中提供，不给主页增加厂商字段编辑按钮。思考内容是否显示是呈现问题，与开关分开。

## 6. 配置与规则应包含什么

下面是讨论和实现时的字段清单，不是必须逐字采用的类型定义。

| 数据 | 内容 |
|---|---|
| 用户偏好 | `thinkingEnabled` 与五档 `effort`；可保留未指定的内部状态以表示服务端默认 |
| 连接 | provider／连接 ID、协议、base URL、key 或 key 环境变量、自定义请求头 |
| 模型能力 | contextWindow、maxOutputTokens、图片／工具支持、思考方式、原生有序等级、能否关闭 |
| 思考规则 | 五档原生 effort 映射、五档预算表、预算范围、关闭编码与参数组合限制 |
| 接口兼容 | 思考编码格式、输出上限字段、必要 headers、role／工具／usage 差异、回传策略 |
| 回传数据 | 完整签名或 opaque items，及其原协议、接口／模型来源；不夹带凭据 |

优先级建议采用“用户明确覆盖 > 明确选择的接口预设与模型规则 > 协议默认行为”。字段允许部分覆盖，但合并后要校验，例如改成预算模式时不能留下互斥的 effort 编码。

规则绑定到“模型 + 当前接口 + 协议”。不能仅看到模型 ID 就自动给任意网关套原厂规则。明确选择原厂预设后，可在该预设内按已核对的模型系列匹配；自定义域名可通过用户明确指定规则复用。

未知接口不必立刻新增代码：用户可以指定已支持的 effort／预算／开关编码模板和等级表。缺少规则时可以沿用服务端默认；当用户明确要求控制而没有可用编码时，应给出配置错误，不声称已经生效。不把所有未知模型强行当成支持 effort。

### 6.1 第 02 批已实现的配置约定（待 review）

入口为 `src/config/byok.ts::loadByokConfig()`，示例见仓库根目录 `byok.example.json`。配置格式为 JSON，不含注释，`version` 固定为 `1`。

- **查找：** 程序化 `configPath` > 进程环境变量 `CLI_AGENT_CONFIG` > cwd 下的 `byok.json`；相对路径按 cwd 解析，不读取 `.env`，不搜索用户目录。BYOK JSON 是唯一启动模型配置来源；任何路径的文件缺失、权限错误、JSON 损坏或字段无效均报错。文件缺失时提示复制示例或指定路径。旧环境启动函数、回退分支、程序化 `config: OpenAIConfig` 入口与 dotenv 读取代码均已删除。
- **连接：** `connections` 是连接 ID 到 `{ api, baseUrl, endpoint?, apiKey?, apiKeyEnv? }` 的字典；必须且只能指定一种凭据来源。示例默认使用本地 `apiKey`；可选 `apiKeyEnv` 只从进程环境取值。连接 ID 用作 `Model.provider`，只是用户的连接身份，不凭 ID 猜厂商规则。自定义 headers、预设和思考编码模板尚未实现，当前填入会报未知字段，待适配器批次接通后再开放。
- **地址：** `baseUrl` 必填，包含所需版本前缀，适配器只追加协议路径，不自动加 `/v1`。可选 `endpoint` 为完整推理 URL，存在时原样用于请求；它不用于推断模型查询地址。两个字段只接受绝对 HTTP(S) 地址，当前不接受 URL 内凭据、查询参数或片段；已带 `/chat/completions`、`/responses` 或 `/messages` 的 baseUrl 会提示改填 endpoint。
- **模型：** `models` 是目录键到 `{ connection, id, name?, contextWindow, maxOutputTokens?, capabilities? }` 的字典。`id` 是发送给上游的 ID，目录键用于选择，`name` 只作显示。窗口／输出上限为正安全整数，输出上限不超过窗口；能力可填 `images/tools/thinking` 三个可选布尔值，未知项保留未指定，当前不据此自动改变请求。多个模型可引用同一个连接。
- **选择与偏好：** `currentModel` 必填并引用有效目录键；程序化 `model` 参数可覆盖本次选择，但不能掩盖无效的保存选择。`thinking` 可省略，默认 `{ effort: "medium" }`，`enabled?` 区分未指定／开／关，关闭仍保存档位。设置传给 Harness；明确开关在当前 Chat 中仍报未实现，不声称已编码。
- **返回与凭据：** 返回模型目录、当前模型副本、偏好和 `getApiKey(modelKey?)`。key 不进入 `Model` 或 session；仅请求所选模型的凭据，其他模型尚未设置环境变量不会阻止启动。`runCli()` 目前启动时读取一次 key 传给已有 Harness；动态凭据及运行中切换在第 10／11 批继续。
- **运行边界：** 目录可保存三种协议，启动目前只接受 `openai-completions`；另两种协议在 HTTP 前明确报错。模型、地址、窗口和输出上限只从 JSON 读取，旧模型环境变量不参与启动。`.env` 和 `.env.example` 已删除，原本机设置已迁入被 Git 忽略的项目 `byok.json`；仓库 `byok.example.json` 只放占位 key。

## 7. 思考映射与编码

### 7.1 五档如何取值

原生有序表为 `[minimal, low, medium, high]` 时，本地五档为 `[minimal, low, medium, high, high]`。原生有序表为 `[low, high, max]` 时，本地五档为 `[low, high, max, max, max]`。这是本项目的顺序映射决定，不代表同名等级跨模型算力相等。

预算模式直接按本地五档查表。默认表采用五个递增值，模型可覆盖；具体数值在预算批次结合输出空间与官方范围确定，不在这里写死一组数值给所有模型。预算是允许／目标思考量，不保证每次实际消耗这么多 token。

校验预算与总输出上限时为回答预留空间，不能无条件套 `max_tokens - 1`。可以参考 CC Switch 的 headroom 思路；若限制导致收敛，可在调试信息中记录实际预算；连最低合法预算都无法容纳时明确报错，不悄悄关思考，也不擅自提高用户输出上限。

### 7.2 effort 优先，预算作为例外

| 模式 | 请求策略 |
|---|---|
| 原生 effort | 只发送映射后的 effort；如接口需要，同时带开启标识 |
| Anthropic 自适应 | 设置 `thinking.type = adaptive`，把 effort 写入 `output_config`，不传旧预算 |
| 预算 | 开启标识 + 对应预算；不常态同时注入 effort |
| 仅开关 | 五档使用同一个开启结果，关闭使用真实关闭编码 |

当前核对的主流接口没有发现必须同时显式设置 effort 与预算的要求。Opus 4.5 是“手动思考需要预算，effort 可选”的例子；首版可只发预算，用预算实现五档。后续确有配合需求时允许内部结果包含两者，并按接口规则校验，不提前建设通用双参数系统。

预算例外按接口记录：原生 Anthropic 的 Opus／Sonnet／Haiku 4.5 等旧模式要预算；4.6 可优先选自适应。阿里云部分 Chat 模型用 `enable_thinking`／`thinking_budget`，其 Responses 接口可能使用 effort。Gemini 2.5 的官方 OpenAI 兼容接口能够替客户端把 effort 转预算，因此不因模型内部使用预算就自动列为客户端预算模式。

依据：[Anthropic 思考模式](https://platform.claude.com/docs/en/build-with-claude/thinking)、[旧预算模式](https://platform.claude.com/docs/en/build-with-claude/extended-thinking)、[阿里云 Chat](https://www.alibabacloud.com/help/en/model-studio/qwen-api-via-openai-chat-completions)、[阿里云 Responses](https://www.alibabacloud.com/help/en/model-studio/qwen-api-via-openai-responses)、[Gemini 兼容接口](https://ai.google.dev/gemini-api/docs/openai)。实际施工时再核对正在接入的具体版本。

### 7.3 字段位置由适配器内部决定

| 格式示例 | 线上字段 |
|---|---|
| OpenAI Chat effort | `reasoning_effort` |
| Responses effort | `reasoning.effort` |
| Anthropic effort | `output_config.effort` |
| Anthropic 预算 | `thinking.type` + `thinking.budget_tokens` |
| 阿里云部分 Chat 模型 | `enable_thinking` + `thinking_budget` |
| DeepSeek 等具体兼容接口 | 按已核对规则使用 `thinking.type`、effort 和回传字段 |

兼容规则可以增补、替换和删除字段，不是把所有可选参数叠加。比如互斥的 effort／预算应只留一种。直接发 HTTP 时，阿里云扩展字段在请求体顶层；Python SDK 的 `extra_body` 不作为 JSON 外壳发送。

明确关闭优先按模型／接口规则编码，例如 `disabled`、`enable_thinking: false` 或支持的 effort `none`。删除不兼容的预算或 effort；个别接口允许保留受限 effort 时按其规则处理。无法真实关闭则返回操作错误，不用低档替代；固定五档与开关的主页布局保持不变。

## 8. 一轮请求及工具往返

```text
启动加载配置 → 选中连接／模型 → Harness 装配 Agent
    ↓
提交本轮消息 → 快照模型 + 思考偏好 + 当前规则
    ↓
统一 StreamFn 入口
    · 选择三协议之一
    · 按规则解析 effort／预算／开关
    · 序列化消息、图片和工具，保留可回传的思考数据
    · 校验输出限制与冲突字段，组装 headers／body
    · 发送并解析为现有 AssistantMessageEvent
    ↓
Agent 执行工具 → 结果加入历史 → 使用本轮快照再次请求
    ↓
落盘完整消息／回传元数据 → 更新 usage → 必要时压缩
```

回传信息和可显示思考文字分开保存。Anthropic 要保留完整 thinking／redacted-thinking 块与签名；Responses 要保留必要 reasoning items／opaque 内容；Chat 兼容接口可能要求 `reasoning_content`。不要将它们拼进普通文本冒充历史思考。

这些回传信息带来源标识。切换模型、接口或协议后，适配器只在请求副本中使用当前接口认可的数据；不把原厂签名或密文直接发给另一家。必要时保留文字／工具语义、略去外来 opaque 数据；如果缺少合法签名导致工具续接无法成立，明确报错，不伪造签名。原 session 数据不被“为发送而清理”的步骤覆盖。

SSE 需要处理任意 chunk 分割、多个事件、usage-only 数据、工具参数增量、正常结束／截断／错误／取消。三协议输出统一事件，保留原 stop reason 供错误与压缩判断使用，不因返回了部分文本就把失败标成成功。

## 9. 一手规则优先接入

首批优先：OpenAI、Anthropic、DeepSeek、Moonshot／Kimi、阿里云／Qwen、z.ai／GLM、xAI／Grok。Gemini 使用官方兼容入口；MiniMax、Xiaomi 等一手接口可按实际使用需求继续补。这个优先顺序可以调整，不要求一次把所有厂商实现完。

每次新增规则，记录厂商／官方端点、协议、模型系列、思考格式、原生等级／预算约束、关闭行为、工具思考回传、参考来源与核对日期。借 CC Switch 起步后用官方文档和请求验收校验；不要直接把它的 null／稀疏映射照搬成我们的主页能力限制。

聚合商先复用三协议与现有编码模板，允许配置覆盖。同名模型在聚合商上不能直接保证原厂字段全被转发；没有实际需求时不做套餐、模型别名和特定网关的精细专用适配。

## 10. 分批施工路线

下面是建议顺序，入口名表示本批要讲清的主流程，不锁定最终 API。每批先依据当前源码选定主流程，以完整功能和最终结构确定交付边界，完成后停下来 review。例如 Responses 的请求组装与流解析若拆开需要临时运行入口，可以合并 05／06；Anthropic 的 07／08 同理。能独立形成最终实现的部分仍可分别讲解和 review。

### 第一块：配置、类型与可复用规则

#### 01｜建立本功能的数据边界

- 主流程：完善现有 `Agent.createLoopConfig()`，不另建重复 wrapper；已实现并经用户 review 确认。
- 输入／处理／输出：现有模型与 Agent 偏好 → 统一连接、模型和思考类型 → 后续适配器可接收的数据。
- 改动范围：`src/types.ts`，Agent 初始状态与必要类型接线；定义三协议、独立开关／五档、回传元数据的最小形状。
- 阅读：Kimi `LlmRequestConfig`、`ThinkingConfigSchema`、当前 `StreamOptions`。
- 本批先保持已有 Chat 启动行为；尚未支持的协议明确未实现。讲清哪些类型是公共边界，哪些属于适配器内部。
- review 点：用户能区分“我的选择”“模型实际值”“线上字段”。

#### 02｜加载 BYOK 配置并选出当前模型

- 主流程：配置加载与选择入口，例如 `loadByokConfig()`。
- 输入／处理／输出：配置路径／环境变量 → 读取、校验连接与模型、应用明确覆盖 → 当前选择与模型目录。
- 改动范围：新增简单配置模块并接入 `runCli()`；JSON 是唯一模型配置入口，文件缺失或损坏时报错，不依赖 dotenv。
- 阅读：Kimi `ProvidersSectionSchema`、`ModelRecordSchema`；CC Switch 预设与模型元数据组织。
- 验证：临时目录中的有效／无效配置、凭据环境变量、旧模型环境变量不能启动或补齐配置；不读取或打印真实 key。
- review 点：配置怎么找到模型、怎么得到凭据、哪些覆盖已生效。

#### 03｜统一适配器入口与规则选择

- 主流程：例如 `streamModel()`，兼容当前 `StreamFn`。
- 输入／处理／输出：model、context、options → 选择共用协议实现和对应规则 → 统一事件流。
- 改动范围：适配器装配、小型规则表；已有 Chat 作为第一个实现。其余协议此时不伪装可用。
- 阅读：Kimi `ProtocolBinding`、`applyThinking()`；CC Switch `piThinkingBindings`。
- 验证：同协议两个连接共用实现；只修改等级表无需增加 controller 分支；特殊模板选择可覆盖默认编码。
- review 点：看一次现有 Chat 请求如何通过新入口，确认没有引入多层 Router。

### 第二块：逐个补齐协议的请求与响应

#### 04｜Chat Completions 思考请求与回传

- 主流程：完善现有 `streamOpenAIChat()`；内部请求构造函数可按需要抽取。
- 输入／处理／输出：统一思考偏好与消息 → 原生 effort／兼容字段、历史思考编码 → 正确 Chat 请求与事件。
- 改动范围：`openai-chat.ts` 及配套规则；保留已验收的工具图片来源和图文顺序；补 thinking 解析与回传元数据。
- 阅读：Kimi `prepareOpenAIRequest()`、`lowerOpenAIMessages()`、流解析；CC Switch `transform.rs`。
- 功能完整后验证：普通文本、工具往返、图片、五档、关闭、usage-only 块、中断；使用本地 HTTP SSE 或已有探针。
- review 点：对照一份最终 JSON，解释每个思考字段来自哪里。

#### 05｜Responses 请求组装

- 主流程：例如 `prepareResponsesRequest()`。
- 输入／处理／输出：内部历史、工具与设置 → input items、tool schema、reasoning、输出参数 → 请求数据。
- 改动范围：新增 Responses 请求转换；保留 reasoning items、工具 call ID 和 opaque 内容；先不接一份半成品流到主页。
- 阅读：Kimi `prepareOpenAIResponsesRequest()`、`normalizeOpenAIResponsesReasoning()`、`lowerOpenAIResponsesMessages()`；CC Switch `transform_responses.rs`。
- review 点：逐个对照 user、assistant、function call、function output 的转换，以及 effort 的位置。

#### 06｜Responses 流解析与完整往返

- 主流程：例如 `streamResponses()`。
- 输入／处理／输出：Responses 请求／SSE → 文本、思考、工具参数、usage、结束状态 → 统一事件流。
- 改动范围：完成解析和适配器接线，不新建第二套 Agent 工具循环。
- 协议功能完整后验证：增量参数、多个工具、reasoning 回传、截断／错误／取消，以及流结束后的 usage。
- review 点：说明一次真实格式的工具往返如何沿已有 Agent loop 继续。

#### 07｜Anthropic 请求与五档预算

- 主流程：例如 `prepareAnthropicRequest()`。
- 输入／处理／输出：统一消息与思考选择 → 自适应／预算／关闭编码及合法 headers → Messages 请求。
- 改动范围：system、content blocks、工具结果、签名回传、必需 max_tokens；建立五个递增预算值并允许模型覆盖，按输出限制校验。
- 阅读：新版 Kimi `encodeThinking()`、`prepareAnthropicRequest()`；CC Switch `effort_to_thinking_budget()` 与预算 headroom 分支。
- 本批决定预算表的具体值，说明与 Kimi 三档、CC Switch 四个预算值的差异。Opus 4.5 可先只传预算。
- review 点：对照自适应开启、预算开启、关闭三个请求，不将参数全部叠加。

#### 08｜Anthropic 流解析与签名连续性

- 主流程：例如 `streamAnthropic()`。
- 输入／处理／输出：Messages SSE → 有序内容块、signature delta、工具参数、usage 与 stop reason → 完整内部消息与事件。
- 改动范围：完成 thinking／redacted-thinking、签名和工具往返接线；取消时不把不完整签名伪装成可回传数据。
- 协议功能完整后验证：文本、思考、工具调用／结果、签名原样回传、截断和取消，含旧预算模式与自适应模式。
- review 点：看一条 assistant 如何从增量变完整消息，再用于下一次请求。

### 第三块：一手规则与运行状态

#### 09｜一次补一家一手厂商／一种接口格式

- 主流程：该厂商的规则应用入口；若现有模板够用，本批主流程是完善已有请求准备函数的规则读取，不为新增数据制造空 wrapper。
- 输入／处理／输出：当前厂商的模型系列、协议和用户覆盖 → 五档映射／开关／回传兼容 → 可使用的官方接口配置。
- 建议按实际需要依次补 DeepSeek、Kimi、Qwen、GLM、Grok、Gemini 兼容入口。OpenAI／Anthropic 已随基础协议起步，继续补所需系列即可。
- 每次只做一家或一个清楚的格式，独立 review；必要时记为 09-a、09-b。不得把这行理解成一次交付七家。
- 阅读：CC Switch 对应 profile／compat；正在接入厂商的官方文档。比较差异后决定借哪些规则，不照搬旧模型判定。
- 验证：最终请求体、五档与关闭、一次完整工具往返；无真实模型条件时明确只有本地协议验证。
- review 点：确认它是“仅新增表”还是“确需新兼容函数”，说明理由。

#### 10｜普通请求的模型、思考与凭据接线

- 主流程：完善 `Agent.createLoopConfig()` 与 loop 的 `streamAssistantResponse()`；按当前边界选择其中一个作为本批主流程。
- 输入／处理／输出：Harness 当前选择 → 本轮设置快照与请求凭据 → 适配器调用、工具后的同设置续接。
- 改动范围：Agent state、prepareNextTurn 的相关更新、Harness 的设置入口；已有 hook 不丢失思考配置。
- 验证：开启／关闭仍保留档位，换模型重映射，工具链不混用两套连接，busy 时设置变更有确定行为。
- review 点：追一遍主页选择如何到达最终请求，而不是只检查 setter 已存在。

#### 11｜压缩使用同一 BYOK 请求链

- 主流程：完善 `Harness.compactWithSignal()`／`summarizeConversation()`，按当前缺口决定主要入口。
- 输入／处理／输出：当前模型、历史与压缩输出上限 → 同一凭据、思考规则及适配器 → 摘要与现有 compaction 条目。
- 改动范围：解决普通请求和压缩的 key 来源分叉；预算重新校验，签名／opaque 元数据与切点策略配合。
- 验证：只配置动态 key 的情况、三协议摘要、较小输出上限、取消不落盘、摘要后续聊；沿用现有压缩门槛。
- review 点：解释为什么同一模型主对话和 `/compact` 不再走两条配置路径。

#### 12｜会话记录与恢复选择

- 主流程：完善会话恢复入口，例如 `resumeAt()` 的设置恢复流程。
- 输入／处理／输出：旧／新 JSONL 与当前模型目录 → 恢复消息、模型引用、开关及档位 → 可继续对话的状态。
- 改动范围：必要时增加不含凭据的设置条目；保存消息回传信息；旧文件没有设置记录时使用当前启动设置。
- 模型引用不存在时保留历史并明确说明使用的当前模型；不凭会话里的旧地址／旧 key 重新连接。跨模型 opaque 数据只在请求副本处理。
- 验证：旧会话、关闭但保留高档位、模型切换后恢复、签名往返、缺失配置及完整工具轮次。
- review 点：区分持久保存的信息与每次运行重新获取的连接／凭据。

### 第四块：用户入口与验收

#### 13｜CLI 模型选择与两个思考控制

- 主流程：完善现有 `ReplController.runCommand()` 或相应选择提交入口。
- 输入／处理／输出：模型／开关／档位操作 → Harness 更新与持久化 → 当前状态显示和下一轮请求。
- 改动范围：可先新增 `/model`、`/thinking on|off`、`/effort` 五档命令及状态显示；具体命令、选择器、快捷键在本批确定。
- 五档保持完整，不因模型少档而隐藏或禁用；仅开关模型不额外提示档位无效。实际错误仍正常显示。
- 配置界面若增加连通性检查，它验证一次真实请求，不宣称从推理 URL 自动获取能力／档位；这部分较大时单独拆批。
- 验证：状态与下一轮请求一致、busy 门槛、thinking 事件显示、非 TTY、不破坏已有输入／附件功能。
- review 点：从用户操作走到设置生效；呈现变化不冒充计算开关。

#### 14｜整条功能验收与文档收尾

- 主流程：按已完成链路组织端到端验收，不为验收另建产品运行入口。
- 本地验证：三协议的多轮对话、工具链、图片能力、思考映射、关闭、session 恢复、压缩、错误和取消。
- 按实际配置补真实一手接口验收；不打印 key，没有条件时记录未覆盖。不能把模拟 SSE 成功写成真实模型成功。
- 完成功能后运行适当的已有回归、`npm run typecheck`、`npm run build` 与 `git diff --check`；行为探针按模块复用，不堆实现镜像测试。
- 更新 README 的配置示例、架构与进度，说明已覆盖模型／接口和未覆盖项。用户没有要求时不 commit、不推送。
- review 点：用户能按文档配置一条连接，并完成对话、工具、思考控制及续聊。

## 11. 错误与兜底的首版边界

默认不建设“失败就不停猜参数”的能力探测器。第一版优先在发送前校验已知规则，返回可定位的配置／接口错误。

- 参数错误、401／403、模型不存在、无法关闭、预算不合法：说明当前模型／协议及原因，不静默换模型、降档或打开思考。
- 若后续确需参数兼容重试，只针对已识别的错误、小范围修正且次数有限；流已输出或工具已执行后，不自动重放整轮。重试规则另作可 review 的小点。
- 沿用现有上下文溢出／压缩策略，保留三协议的原始错误分类；不要吞掉接口错误伪装为正常结束。
- 未指定参数与明确关闭不同；默认行为可以是省略，明确关闭必须有对应编码或明确失败。

## 12. 当前交付与后续记录

第 01 批已通过用户 review 并提交。第 02 批配置加载及启动选择已实现，验证通过，用户已授权提交推送；已讲解类型、配置示例及 main／Chat／index 接线，`byok.ts` 主体留待用户在 Mac 上继续 review。完整 BYOK 尚未完成，review 确认后再按用户安排进入第 03 批。

| 批次 | 状态 | 完成／review／验证记录 |
|---|---|---|
| 01 | 已实现，review 已确认 | `createLoopConfig()` 模型／偏好快照、loop 传递与 hook 更新；9 项本地行为验证和相关既有回归通过；用户授权提交推送 |
| 02 | 已实现，获准提交，主体待 review | JSON 唯一配置入口、凭据读取、启动选择、完整 endpoint；11 项本地配置验证与既有相关回归通过；Mac 继续看 `byok.ts` |
| 03 | 未开始 | 统一适配器入口与规则选择 |
| 04–08 | 未开始 | 三协议基础能力 |
| 09-a… | 未开始 | 一次一家的规则补充 |
| 10–12 | 未开始 | 请求、压缩与会话状态 |
| 13–14 | 未开始 | CLI 与整条验收 |

进入开发后把当前批次单独展开记录，不只勾选整个功能。已确认的产品行为继续保持；实现组织随源码和 review 调整，修改后同步本文与 [progress.md](./progress.md)。

### 01｜实际交付记录（2026-10-12，review 已确认）

- **输入与输出：** `Agent.createLoopConfig()` 从当前 `Model`、`thinking` 偏好和现有 Agent 请求设置构造 `AgentLoopConfig`。模型用 `structuredClone` 复制（包含嵌套能力），偏好单独复制；普通 state 修改不改变本轮工具后续请求。`continueFromContext()` 复用同一入口。
- **公共字段：** `ModelApi` 为 `openai-completions / openai-responses / anthropic-messages`；`ThinkingLevel` 为固定五档；`ThinkingPreferences.enabled?` 区分未指定／开启／关闭，`effort` 始终保存选中档位。`Model.capabilities` 中缺失项表示未知，当前尚未按能力限制请求；`maxOutputTokens?` 为模型默认输出设置，显式请求 `maxTokens` 优先。
- **loop 接线：** `streamAssistantResponse()` 只向适配器传 `apiKey / signal / maxTokens / thinking`，不再把循环 hooks 一并展开。保留动态 key 获取路径；`prepareNextTurn` 原来的模型覆盖仍可用，补齐完整思考偏好覆盖并复制返回对象。仅更新 context 时保留请求设置。
- **回传边界：** `ThinkingContent.thinking` 保留显示文字，`replay?` 单独保存 `{ source: { api, provider, model, baseUrl }, payload }`。payload 为完整、可 JSON 序列化的原生思考数据，可包含签名／opaque items；source 仅存无凭据的接口身份。适配器完成合法数据组装后才附加 replay；其生成、校验、发送和来源清理尚未实现。已有 JSONL 消息行能原样保存这些可选数据，无需改格式，旧 thinking 块继续可读。
- **Harness 与 Chat：** `HarnessOptions.thinking?` 传入 Agent；`setThinkingLevel()` 仍明确未实现，CLI 未新增命令。现有 Chat 请求在未指定开关时保持原行为；给 Chat 适配器传另两种协议或明确开关时，在 HTTP 前返回未实现错误。
- **参考取舍：** 阅读固定 TS Kimi Code 的 `LlmRequestConfig`、`ThinkingConfigSchema`、`ThinkPart` 和 provider 定义，借鉴统一请求边界与偏好分离。保留本项目 `StreamFn`、事件与工具循环；完整 JSON replay payload 及固定五档是本项目的数据设计，未复制 Kimi 的 DI、动态档位或 CC Switch 代理代码。
- **验证：** 本地 `node --import tsx --test test/byok-request-settings.test.ts` 9 项通过，覆盖五档传递、三种开关状态、保留档位、工具续接快照、显式 hook 更新、输出上限、Harness 初始偏好、旧／新消息 JSONL 和旧 CLI 配置请求，以及未实现能力不发 HTTP。既有 Agent 3 项、loop 4 项、图片序列化 13 项均通过；`npm run typecheck`、`npm run build`、`git diff --check` 通过。只使用假流、mock fetch 与临时会话目录，不读取真实 key、不调用真实模型。新增验证文件按现有约定只留本地，未改 package scripts。
- **Review 与提交范围：** 用户已逐项阅读类型、Agent 状态与快照、loop 更新和适配器边界，确认本批并要求提交推送。提交范围为本批 5 个源码文件及 README／3 份设计进度文档；不纳入本地测试、凭据和构建产物。

### 02｜实际交付记录（2026-10-15，获准提交，主体待 review）

- **主流程：** `loadByokConfig()` 接收 cwd、可选路径／模型选择及环境；查找并读取配置，使用已有 TypeBox 做结构校验，再检查连接凭据来源、URL、模型引用和输出限制，构造无凭据的模型目录，返回当前选择、偏好与独立 `getApiKey()`。用户 review 中明确不需要兼容旧启动方式，已删除全部旧配置入口；JSON 缺失或损坏均报错。
- **配套接线：** `runCli()` 使用目录选择、显示名和思考偏好装配 Harness，未实现协议在启动时报错；`Model.endpoint?` 与 Chat 请求接通，适配器直接使用完整地址。`src/index.ts` 导出加载入口，根目录增加配置示例。用户进一步要求迁移实际配置：原 `.env` 四项设置已写入项目 `byok.json`，读取并逐项校验后删除 `.env`、`.env.example` 和 `src/env.ts`；默认查找改为 cwd，`.gitignore` 排除本机 JSON，示例改为直接填写假 key。
- **参考取舍：** 阅读固定 Kimi TS 的 `ProvidersSectionSchema`、`ModelRecordSchema`、`ThinkingConfigSchema`，借鉴连接／模型／偏好分开保存；Pi `ModelRegistry.getApiKeyAndHeaders()` 用于对照凭据与模型分离。JSON 位置、严格校验、单文件目录和 endpoint 约定由本项目确定；复用现有 TypeBox，不增加 Zod、DI、发现服务或多层继承。本批没有导入 CC Switch 模型规则，待实际编码批次再核对。
- **验证：** `node --import tsx --test test/byok-config.test.ts test/byok-request-settings.test.ts test/tool-result-images.test.ts` 通过，其中配置 11 项、请求设置 9 项、图片序列化 13 项。覆盖共享连接、模型选择、偏好与输出设置、环境凭据、缺 key、损坏／缺失配置、严格校验、旧环境变量不能启动或补齐 JSON、cwd 默认文件、忽略本地 `.env`、地址约定和不支持的协议；CLI 请求回归使用 BYOK JSON。本机 HTTP SSE 验证 base／endpoint 两种地址、请求 key／模型／输出上限和 session 不含凭据。`npm run typecheck`、`npm run build`、`git diff --check` 通过。行为测试只用临时目录与假 key；另按用户指令读取本机 `.env` 迁移真实配置并离线校验，未输出 key、未调用真实模型。本地旧模型探针同步改为读取 BYOK；整个 test/ 现仅保留本地，对应 npm 测试／探针入口已移除。
- **交付与 review：** Chat 可从 JSON 配置启动；三协议完整运行、厂商思考规则／headers、动态凭据、运行中选择与会话设置恢复仍待后续批次。用户已授权提交推送当前改动，`byok.ts` 主体留待 Mac 继续 review，第 03 批未开始。本次同时按要求将整个 `test/` 从 Git 取消跟踪并保留本地文件，移除对应 npm 测试／探针入口；后续在近期两个功能点完成后另建测试框架。本机真实配置不提交，跨机器 review 可先使用 `byok.example.json`。
- **提交前检查：** 本地输入 68 项、配置 11 项、请求设置 9 项和图片序列化 13 项验证通过；使用直接执行本地测试文件的方式，不依赖已移除的 npm 测试入口。类型检查、构建与差异检查通过，取消跟踪的 10 个测试文件本地副本完整。
