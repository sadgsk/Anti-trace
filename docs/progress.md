# 开发进度与历史

记录各版本做过的改动，以及当前版本还有哪些工作和验收未完成。新对话先读这一页，再打开架构书了解当前设计和后续目标。下方历史记录保留当时的决定；已被替代的旧约定不作为今天的开发规则。

| 项 | 值 |
|---|---|
| 项目 | `e:\pi-harness\cli-agent`（与 `e:\pi-harness\pi` 并列） |
| 当前版本 | **v1.2** |
| 阶段 | **Harness 与 Agent 内部能力保留；旧终端输入和 REPL 接线已归档，`npm start` 暂不能对话。新输入第 1–4 批已完成；第 5 批粘贴缓冲、同步提交门槛、异步图片路径/剪贴板读取及生命周期清理已整批完成、验证并经用户 review 确认；输入历史召回已移除；第 6–8 批和思考等级/BYOK 后续规划仍待推进。** |
| 架构书 | [architecture.md](./architecture.md) |
| 输入迁移计划 | [claude-code-input-architecture.md](./claude-code-input-architecture.md) |
| 暂不修的 bug | [future-issues.md](./future-issues.md) |
| 对照代码 | `e:\pi-harness\pi` |
| 最后更新 | 2026-10-07 |

**当前协作约定：** 产品方向和框架原则见 [架构书 §0](./architecture.md#0-产品方向与推进方式)。

1. 每批必须新增或完善一个主流程函数：说明它接收什么、如何调用配套功能、向外返回什么结果；期间更新的功能函数、必要类型和接线不计数量，不再按函数总数拆批。每批动手前先说明主流程函数和配套改动，再写入文件；写完停下等用户 review，确认后再继续下一批。用户不用手动粘贴代码。
2. 一个功能全部实现完再开始测试，不在功能做到一半插入探针或验收；验证方式和结果在功能完成后一起交代。
3. 实现过程中发现问题（设计冲突、边界情况、影响面）当场说明，不要等写完、用户 review 完再补一句「这里有问题」。
4. 带着写时，讲解应覆盖参考来源和本项目的取舍；有 Pi 对照时给出路径、函数名，自定义设计则直接说明理由。只有用户明确要求逐行解释某个函数时，才启用 [架构书 §0.4](./architecture.md#04-源码讲解方式) 的讲解标准；其他情况下按当前问题直接说明概念、逻辑或作用。
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

当前主线：搬家 → 管家框架 → session 记忆 → 上下文容量（窗口/计量/显示/压缩） → 手动压缩 → 思考等级与 BYOK 合并设计和实现。原步骤编号留作历史索引，第 5 步先于合并里程碑施工。v1.3 接 TUI。按小点交付并 review。

**终端输入迁移：**旧输入五文件已归档，`main.ts` 当前只报告入口不可用。第 1–4 批已完成，提交回调收到最新文本/光标快照，上下键只在当前输入中移动光标。第 5 批按本次要求一次性交付：`PasteHandler.handleInput()` 合并明确粘贴、超过 800 字符的块、图片路径和 pending 后续文字；100 ms 静默后按顺序交付文本/图片。pending 同步覆盖缓冲与异步读取，Enter 被消费且不延迟提交；编辑动作先完成前面的粘贴。图片读取异步进行，失败路径及剩余正文原样保留，宿主停止或草稿替换后不接受旧结果。基础输入通过 `onImagePaste` 交付图片，第 6 批再统一附件草稿、占位符与撤销，第 7–8 批接 REPL 和做终端验收。`npm run test:input` 68 项通过，类型检查、构建和差异检查通过；未调用模型或读取真实剪贴板。旧输入测试 `npm run test:input:stash` 只验证归档实现。源码对照、行为差异及边界见 [输入迁移计划](./claude-code-input-architecture.md)。

**图片插入项已收尾：** OpenAI 图文关联修复通过本地请求体验收：本批全部 tool 回复连续，含图结果的完整内容按工具来源分组发送，图文顺序保留；普通 user 图文输入也保持原序。纯文字、空结果、批次边界和重复转换均已验证。未调用真实模型，本次验收范围是消息序列化；中断后的工具配对问题不在本次修复范围。

**主线下一步：** 第 5 步 `/compact` 入口已接通：仅当 `used > window / 4` 才尝试现有压缩；没有旧轮次或刚压完没有新消息则不调用模型。假 `StreamFn` 已验证门槛、写盘与恢复；真实模型摘要和续聊仍待验收。review 后先调研 Kimi Code 等实现，确定思考等级与 BYOK 共用的模型能力、配置、映射和失败兜底方案，再分小批实现。具体档位、映射方式及重试条件尚未定。默认 `256000` 窗口下，手动入口需 `used > 64000`，不再以短会话作为真实模型验收方式。

| 步 | 内容 | 状态 |
|---|---|---|
| 0 | 搬家：`src/tools/*` → `src/harness/tools/`，`prompt.ts` → `src/harness/prompt.ts`，改 import | [x] |
| 1 | `src/harness/harness.ts` 框架 + `test/probe-harness.ts`；`main.ts` 改用 Harness | [x] |
| 2 | `src/harness/session.ts` + probe；Harness 写入 / 会话名（前 10 字）/ `/new` / `/resume`（名字+上次打开时间） | [x] |
| 3 | 上下文容量：`context.ts` + `compaction.ts`；usage；REPL `ctx`；`/context`；阈值压缩；报错或空 `length` 重试；`stop` 超窗只压。代码和假流探针完成，真实模型验收待做 | [x] |
| 5 | `Harness.manualCompact()` 及假流验证已完成；旧 CLI `/compact` 接线随输入层移除，待新 REPL 恢复并做真实模型验收 | [ ] |
| 4+6 | 思考等级与 BYOK 合并规划：三协议基础接入、可配置的模型能力与请求映射、失败兜底；具体方案待调研 | [ ] |
| 7 | 新输入和 REPL 按迁移计划完成后，再做端到端验收与公开试用准备 | [ ] |

第 3 步的内部状态：

- 已接通：`Model.contextWindow` 与环境配置（`env.ts` 读 `OPENAI_CONTEXT_WINDOW`，当前缺省 `256000`，无效值回退）、`estimateMessagesTokens` 整段估算、`Harness.setContextWindow` / `contextUsage`、REPL `/context` 与每轮后的 `ctx used/window`。`usedTokens` 在 `prompt` 结束后更新，`newSession` 归零，`resumeAt` 按加载的 messages 重算。
- 已接通：接口 `usage`。`AssistantMessage.usage?`；`openai-chat.ts` 请求带 `stream_options: { include_usage: true }`，在 `choice` 判断之前解析流末尾 usage 块并写入 assistant；`harness.ts` 的 `prompt` 优先取最后一条 assistant 的 `input + output`，取不到回退 `estimateMessagesTokens`。假 stream 已覆盖两条支路（`probe-harness` 用例 7）；deepseek 已实测返回 usage 且端到端解析正确。
- 已接通：切点、原上下文和 tools 发送给摘要模型、工具调用则重试、摘要写回与持久化、阈值触发和溢出后一次重试。默认保留最近 `20000` token，`Harness.compact()` 已可调用；假流探针覆盖主要路径。
- 已接通：CLI 手动 `/compact` 通过 `Harness.manualCompact()` 判断 1/4 用量门槛后复用 `compact()`；重复调用和无切点不会发起摘要请求。摘要包装文字改为适用于主动压缩。真实模型的摘要与续聊验收待做；可恢复溢出错误提前显示的问题已记在 `review-records.md`。

下面更新记录保留当时的决定与状态；当前实现以上面的清单和源码为准。

### v1.2 更新记录

| 日期 | 发生了什么 |
|---|---|
| 2026-10-07 | 用户 review 确认输入迁移第 5 批，并要求提交推送。提交前复跑 `npm run test:input`，68 项通过；`npm run typecheck`、`npm run build` 和 `git diff --check` 通过。同步当前状态与迁移计划；图片附件草稿、占位符、撤销及 REPL/Harness 接线仍按第 6–8 批继续。 |
| 2026-10-06 | 按用户要求一次性完成输入迁移第 5 批，待 review。新增主流程 `PasteHandler.handleInput()`：明确粘贴、超过 800 字符的输入块、图片路径与 pending 连续片段进入 100 ms 缓冲；同步 pending 覆盖缓冲及全部异步读取，粘贴同批 Enter 不抢先提交，编辑动作与文本/图片结果按事件顺序交付。新增 `image-paste.ts` 的保序路径解析、异步文件/剪贴板读取、2000 边长缩放；失败图片路径和其他正文原样保留，空 macOS 图片粘贴独立处理，防止立即打字吞掉附件。快捷键集中映射 `input:paste-image`（Windows Alt+V，其他平台 Ctrl+V），允许换绑。宿主 stop、EOF、close、错误和信号退出通知控制器清理，草稿替换/停止通过 generation 丢弃旧结果。新增持久粘贴及图片测试，更新原有延迟粘贴行为测试；`npm run test:input` 68 项、`npm run typecheck`、`npm run build`、`git diff --check` 通过。验证使用模拟 TTY、注入图片 reader 和 PATH 假剪贴板命令，未读真实剪贴板、未调用模型。图片完整草稿、长文本占位、撤销、REPL 和真实跨终端/平台验收仍属于第 6–8 批；未提交 Git。 |
| 2026-10-05 | 按用户要求取消输入框的历史召回。删除 `text-input-history.ts`，清理控制器的历史列表、草稿备份、`onHistory` 回调和 `replaceHistory()` 接口；Up/Down 直接调用当前文本的纯编辑操作，首末显示行保持光标原位。同步移除相关测试和第 6 批的输入历史规划，保留完整草稿撤销的计划。更新行移动边界和状态替换验证，`npm run test:input` 35 项通过，`npm run typecheck`、`npm run build` 和 `git diff --check` 通过。 |
| 2026-10-05 | 按本次“未完成就继续，完成后提交推送”的要求收尾输入迁移第 4 批。新增同步主流程 `TextInputController.handleAction()`、文本历史、`useTextInput`、`BaseTextInput` 和独立宿主适配器；补齐 Enter/换行、编辑快捷键、历史草稿光标恢复、resize 和提交快照。参考 CC `useTextInput`、`BaseTextInput`、`useArrowKeyHistory`，以同步控制器避免同批文字加 Enter 读取旧状态。修复 Unicode 协议文字/小键盘数字丢失，显示投影处理孤立代理和单独零宽字素；宿主在回调停止后丢弃同批剩余事件，回调异常时恢复 raw mode 并清理监听。新增持久 `npm run test:input`：36 项行为测试通过；`npm run typecheck`、`npm run build`、`git diff --check` 通过。通过真实 Ink 加模拟 TTY 验证，未调用模型。第 5–8 批及最终真实终端手测仍待推进，`main.ts` 未恢复交互。 |
| 2026-10-05 | 为架构书 §0.4 补充适用前提：只有明确要求逐行解释某个函数时才启用，其他情况下忽略该格式，直接回答当前问题；同步进度页协作约定。 |
| 2026-10-05 | 按用户确认的讲解方式，在架构书新增 §0.4：保留原代码，每行解释紧跟对应代码行；自然语言直接说明参数、变量、条件、状态变化与调用效果，仅补充理解所需的语法；每段说明用途，必要时用具体数值演示参数传递。进度页协作约定改为链接该节，后续对话沿用。 |
| 2026-10-05 | 继续第 4 批，完善主流程 `applyTextInputAction()`：上下移动操作要求调用方传入 `availableColumns`，经 `moveVerticalCursor()` 依次生成布局、定位当前行列、寻找相邻行字素边界并返回状态；首末行保持光标。新增 `text-input-layout.ts` 的 `layoutTextInput()` 与行列互转函数，以原始 UTF-16 下标关联显示列；参考 CC `Cursor.up/down` 和 `MeasuredText`。本项目按字素满列折行并保留空白，软折行共享下标归下一行；Tab 显示按 4 列制表位、窄行限制到可用宽度，控制字符及超宽字素只在显示层用 `�` 替代，CRLF 和原文不改写。将已有 `string-width 8.3.0` 列为直接依赖。`npm run typecheck`、`npm run build` 通过；第 4 批完整前不做行为探针，当前小批待用户 review，尚未接输入组件或真实终端。 |
| 2026-10-03 | 按用户要求取消每批最多三个函数的限制，改为每批必须新增或完善一个主流程函数，配套功能函数、类型和接线不计数量；同步进度、架构书与输入迁移计划。继续第 4 批，新增纯编辑主流程 `applyTextInputAction()` 及 `TextInputAction`，统一调用插入、左右移动和前后删除；新增 `moveCursor()`、`deleteText()`，按完整字素移动/删除，支持跨换行，删除后重新校正光标边界。参考 CC `Cursor.left/right/backspace/del`，不引入终端按键判断或屏幕测量。`npm run typecheck`、`npm run build` 通过；第 4 批完整前不做行为探针。本批已由用户逐段 review 并要求提交，上下行、Enter、历史与输入组件仍待后续完成。 |
| 2026-10-03 | 第 3 批分发器经用户逐段 review 后，按要求进入第 4 批。第一小点新增 `src/cli/input/text-input-state.ts` 的 `TextInputState`、`getGraphemeBoundaries()`、`createTextInputState()` 和 `insertText()`：文本保持原样，光标按 UTF-16 下标及字素边界处理，支持初始状态和光标处插入；返回新状态，不读取事件或渲染。参考 CC `Cursor.fromText`、`insert` / `modifyText`、`MeasuredText.getGraphemeBoundaries`，采用纯函数作为后续 React 输入状态的编辑基础。`npm run typecheck`、`npm run build` 通过；按约定，第 4 批完整后再做行为探针。当前插入小点待 review，移动、删除、输入组件及 REPL 尚未实现或接线。 |
| 2026-10-03 | 新输入第 3 批第二小点：新增 `src/cli/input/input-dispatcher.ts`，实现 `eventToKeystroke()`、`InputDispatcher.configure()` 和 `dispatch()`。焦点目标以稳定 symbol 身份区分组件，按焦点到 Global 的顺序解析并按命中上下文调用动作；单字符 text 参与快捷键匹配，完整粘贴及多字符块原样交给焦点输入。同步管理 pending：组件或配置改变时清空、接错后续键时重新独立匹配、Esc 取消、按 CC 的 1 秒有效期在下次输入时检查过期；响应和鼠标不打断组合键。参考 CC `use-input.ts`、`ChordInterceptor`、`KeybindingSetup.setPendingChord` 和 `useKeybinding.ts`，通过集中分发避免依赖多个监听器的注册顺序。第 3 批逻辑完整实现后，10 个一次性内存行为探针、`npm run typecheck` 和 `npm run build` 通过；探针未写入仓库，未接真实终端或模型。当前小点待 review，确认后进入第 4 批编辑器与基础组件，`npm start` 仍不可对话。 |
| 2026-10-02 | 新输入第 3 批第一小点：新增 `src/cli/input/keybindings.ts`，实现 `matchesKeystroke()`、`matchesChord()` 和 `resolveKeybinding()`。键名及 Ctrl/Alt/Shift/Meta 精确匹配；调用方按焦点上下文到 Global 排序，同上下文的相同绑定以后置配置为准；连续组合键返回 pending、完成或取消，null 覆盖不会单独留下长组合键前缀。默认映射覆盖提交、换行及中断动作名，未执行业务动作。参考 CC `match.ts` 和 `resolver.ts::resolveKeyWithChordState`，使用独立类型避开还原源码的 `keys` / `chord` 等声明差异。`npm run typecheck` 和 `npm run build` 通过；焦点、普通文字事件适配和动作分发未接入，行为探针待第 3 批完整实现后进行，当前小点已由用户逐段 review 并要求提交。 |
| 2026-09-30 | 新输入第 2 批完成：`TerminalInputParser.feed()` 以 `StringDecoder` 保留跨 chunk UTF-8，缓冲不完整转义与 bracketed paste；`parseKey()` 保留按键名及 Ctrl/Alt/Shift/Meta，CSI u、modifyOtherKeys、CSI/SS3 均可解析；`startTerminalHost()` 将唯一 stdin 回调转发为事件，50 ms 恢复不完整普通转义、500 ms 恢复进行中的粘贴。终端响应和鼠标事件不流入文字。对照 CC `tokenize.ts`、`parseMultipleKeypresses`、`InputEvent`；本机参考仓库位置与文档原相对路径不同，HEAD 一致。`npm run typecheck`、`npm run build` 和被忽略目录中的临时探针 6 例通过。焦点、快捷键、编辑器及 REPL 尚未接入，`npm start` 仍不可对话。 |
| 2026-09-29 | 新输入第 1 批完成：浅克隆 `oboard/claude-code-rev` 到并列目录，HEAD 为文档中的 `3b0498a`；核对其 `src/ink/components/App.tsx` 的 raw mode、stdin 与 bracketed paste 生命周期。项目用 React 19 + Ink 6.5.1 渲染，Ink 接虚拟输入流，`TerminalHost` 独占真实 stdin 的原始字节并管理终端模式。`npm run typecheck`、`npm run build` 通过；本机临时测试 2 例通过，按用户要求不入库。按键解析与 REPL 接线尚未实现，CLI 仍不可对话。 |
| 2026-09-29 | 按用户决定停止旧输入方案：五个实现文件归档到 `src/cli/input/stash/`，旧 REPL 输入循环和图片暂存从 `main.ts` 移除，`npm start` 明确报暂不可用。新增 [Claude Code 输入架构迁移计划](./claude-code-input-architecture.md)，后续按源码链路逐批实现并等待 review。验证：类型检查通过、归档输入 31 个测试通过、启动入口以非零状态报告不可用。新输入尚未实现。 |
| 2026-09-26 | 为多行代码粘贴提前发送的问题接入新的终端输入底层：raw mode 与 bracketed paste 解析输出独立的文本、按键、粘贴事件；`PasteBurst` 为无标记的快速输入提供时间判断兜底；`DraftEditor` 独立维护可编辑多行草稿；`CliPrompt` 暂时负责 CLI 显示与 Enter 提交，支持 Ctrl+J / 可辨别的 Shift+Enter 换行、`/paste` 后 Ctrl+D 退出安全粘贴、原有图片快捷键与斜杠命令。非 TTY 管道在 EOF 交付完整文本。输入测试、类型检查、构建、macOS 伪终端请求体与 SIGTERM 清理验证及独立代码 review 已通过。慢速无标记粘贴存在不可判别边界；实际 Windows / WebStorm / Terminal.app 手测待做。 |
| 2026-09-26 | 思考等级与 BYOK 改为同一项待设计功能，不再按原第 4、6 步分别实现。规划要求模型能力与请求映射可在配置中调整，兼顾不同协议和网关差异，并设计明确反馈及有限重试或兜底；避免新厂商都要在核心代码追加特例。具体档位、能力信息来源、映射形状和重试条件待进一步对照 Kimi Code 等实现后决定。本次只更新规划文档，未改实现。 |
| 2026-09-26 | 用户调整施工顺序，先接简单的手动入口。`Harness.manualCompact()` 在 `used > window / 4` 时调用现有 `compact()`，否则直接返回；无新消息时不重复压缩。REPL 加 `/compact` 与结果提示，摘要包装不再声称已耗尽上下文。验证：`npm run typecheck` 通过；一次性假 `StreamFn` 探针覆盖恰好 1/4、超过 1/4 但只有一轮、成功摘要和 JSONL 恢复、压后重复调用；PTY 里 `/compact` 的低用量提示正常。未调用真实模型，当前步骤等用户 review 后再继续。 |
| 2026-09-25 | 按当前源码纠正第 3 步状态：默认窗口 `256000`；摘要保留原上下文和 tools，在末尾加指令，工具调用则重试；自动压缩和溢出恢复已接通，假 `StreamFn` 探针已通过，真实模型压缩验收暂缓。v1.2 新增思考等级之后的手动 `/compact` 与最小 BYOK 三协议（OpenAI Chat Completions、Anthropic Messages、OpenAI Responses）；v1.3 安排 TUI。这里只记录需求和现状，新增功能尚未动手。 |
| 2026-09-25 | 会话存储继续使用线性 JSONL。本地的追加、列表和恢复需求不引入 SQLite；会话树、`/tree`、树状 fork 和 Pi v4 session 迁移明确不做。 |
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

## v1.3（后续）

原计划在 v1.3 才替换 TUI；现已提前停用旧输入，并开始 Claude Code 输入架构迁移。现行分批顺序以 [输入迁移计划](./claude-code-input-architecture.md) 为准。旧输入的历史实现和验证记录保留在上文，不代表当前 CLI 可用。

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
