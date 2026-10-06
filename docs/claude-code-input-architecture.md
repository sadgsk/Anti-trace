# Claude Code 输入架构迁移计划

## 当前状态与目标

2026-10-07：第 1–5 批已完成并 review；剩余第 6–8 批按用户要求一次性实现，完整草稿、附件引用、撤销/重做、提交展开、REPL 命令及 Harness 显示链路已接通，`npm start` 恢复交互。本机扩展 115 项测试、类型检查和构建通过，其中 7 项终端/入口验收使用 macOS 真实 POSIX PTY 和本地 HTTP SSE。现按用户要求删除旧 `stash` 和同步 `utils/image.ts` 并提交推送；新增测试和 PTY 脚本只留本地，`test:input` 恢复为仓库已有的基础回归。Windows/Linux 原生终端、真实剪贴板及具体终端应用仍需手测。没有调用真实模型或读取真实剪贴板。

目标是按本地 `claude-code-rev` 的输入链路重建终端交互：**一个 stdin 所有者 → 按键/粘贴事件 → 聚焦的文本输入组件 → 草稿及附件状态 → 提交给 Harness**。逐层对齐 CC 的事件语义、粘贴行为、编辑行为和快捷键分发。每次按用户指定范围交付可 review 的实现；本次第 6–8 批按用户要求一次性交付。

CC 使用 React 组件和仓库内的定制 Ink。新输入也按这两层组织：终端事件与渲染宿主在 `src/cli/ink/`，输入组件在 `src/cli/input/`，REPL 的命令及 Harness 接线在 `src/cli/repl/`。第 1 批采用 React 19 与 Ink 6.5.1 作为渲染依赖；Ink 只接一条独立的虚拟输入流，不读取真实 stdin。真实终端的输入事件由本项目宿主实现，不能假定普通 Ink 与 CC 的输入事件行为相同。后续只移植本项目需要的输入链路，每次给出对应源码和差异。

对照源码：`../claude-code-rev`（Windows 本机 `E:\pi-harness\claude-code-rev`），HEAD 为 `3b0498a`。该仓库自述为从 source map 还原、含 shim 的源码树，并非官方原始仓库。每一步以文中列出的具体文件为阅读入口；发现该还原版与实际依赖接口冲突时，先记录差异，再决定项目中的实现。

## 对照关系与职责

| CC 源码入口 | 本项目目标职责 |
|---|---|
| `src/ink/components/App.tsx`、`src/ink/parse-keypress.ts`、`src/ink/termio/tokenize.ts` | 唯一 stdin 读取者；raw mode、bracketed paste、终端能力和清理；跨 chunk 解析为带修饰键的按键、文本或完整粘贴事件 |
| `src/ink/events/input-event.ts`、`src/ink/hooks/use-input.ts` | 统一事件对象；按聚焦状态分发，不给输入组件另设竞争性的 stdin 监听器 |
| `src/keybindings/*` | 将键值、修饰键、上下文和动作分开；处理冲突、优先级与组合键；输入组件只实现动作 |
| `src/hooks/useTextInput.ts`、`src/components/BaseTextInput.tsx` | 文本、光标、多行和 Enter 行为；基础输入组件连接事件与编辑状态 |
| `src/hooks/usePasteHandler.ts`、`src/utils/imagePaste.ts` | 明确粘贴优先；拼接连续片段；处理图片剪贴板与图片路径 |
| `src/components/PromptInput/PromptInput.tsx`、`src/hooks/useInputBuffer.ts` | 提示词草稿、粘贴文本及图片引用、撤销、显示和提交门槛 |
| `src/utils/handlePromptSubmit.ts`、`src/screens/REPL.tsx` | 提交前展开文本引用、筛出已删除的图片、命令分发并调用 Harness |

当前输入主链路：

```text
stdin (唯一读取者)
  → 终端协议解析 / InputEvent（完整粘贴带 isPasted）
  → 焦点与快捷键分发
  → TextInputController.handleInput → PasteHandler：普通内容直接编辑，粘贴合并后交付文本/图片
  → TextInputController.handleAction：pending 时拦住提交，编辑按序处理
  → useTextInput → BaseTextInput 重画（同步快照含 isPasting）
  → PromptInputController：草稿文字 + pastedContents + references + 光标/撤销
  → PromptInput 重画 / 提交完整草稿快照
  → ReplController.submit → preparePromptSubmission：展开文本引用、收集仍被引用的图片
  → 命令分发 / Harness.prompt(text, images)
```

显示主链路：编辑器草稿变化 → React/Ink 重画输入组件；`Harness.subscribe` 收到 Agent 事件 → `ReplController` 更新已完成条目与实时回复 → `ReplView` 用 Ink `Static` 和动态区域输出。交互模式下只有 Ink 写界面，不订阅旧 `renderEvent`；只复用 `render.ts` 的工具结果预览函数。非 TTY 模式由入口增量写出回复，在 EOF 后提交一次完整文本，不渲染编辑器。

当前文件边界：

```text
src/cli/ink/       terminal host、tokenizer、parse-keypress、InputEvent、useInput
src/cli/input/     keybindings、TextInputController、BaseTextInput、PasteHandler、PromptDraft、PromptInputController、PromptInput
src/cli/repl/      ReplController 命令路由与 Harness 事件、TerminalRepl 装配与显示
```

### 解耦约束与快捷键验收

这是本次重制的完成条件，也是后续 TUI 继续使用这套输入底座的边界：

- 终端层只产出保留键名、修饰键、文本和粘贴标记的事件，不知道 `/new`、提交、Harness 等业务动作；焦点分发也不解析业务命令。
- 快捷键层集中维护“按键或连续组合键 + 上下文 → 动作”的映射及优先级。输入组件注册编辑动作，REPL/TUI 注册各自的上层动作；按键写法不散落在组件和 `main.ts` 的条件分支中。
- 输入组件维护草稿和编辑状态，向上层交付完整草稿快照或明确的动作。上层只消费这些结果，不读取原始 stdin、转义序列或光标内部状态。
- 给**已有动作**增加另一种可识别的组合键，只改快捷键映射；增加**新动作**，只增加映射及对应层的处理器，不重写终端解析、焦点分发、草稿和提交链路。连续组合键由同一个解析器处理，不为每组键另建一条输入链路。
- 第 3 批验证“同一动作换绑另一组键”“连续组合键”“不同焦点下同键不同动作”；第 8 批在真实 PTY 中验证改绑、组合键和 Global 动作不需要修改终端层或编辑器。真实终端无法区分、或尚未上报的组合键，需要在终端协议解析处做局部适配，并记录该终端的限制；不承诺终端本身无法提供的按键信息。

### 必须保持的行为

1. **终端**：启用 raw mode 和 bracketed paste；停止、异常退出或切换交互界面时恢复终端状态。粘贴标记和 UTF-8 字符可以跨任意 stdin chunk。终端响应、按键与粘贴分流；不让两个读取者争抢 stdin。
2. **按键**：底层保留实际键名和 Ctrl/Alt/Shift/Meta 等修饰键，不把 `Ctrl+Shift+C` 提前折叠成 `Ctrl+C`。普通 Enter 进入提交路径；CC 可识别的 Shift/Meta+Enter、反斜杠加 Enter 进入换行路径。建议、选择器等有焦点时先由相应上下文处理。Up/Down 只移动当前输入中的光标，在首末显示行保持原位；本项目不提供已提交输入的历史召回，第 6 批也不增加该功能。
3. **粘贴**：带标记粘贴是单个事件，内容中的换行和 Tab 不触发提交或补全。参照 CC 的 `usePasteHandler`，明确粘贴、大于 800 字符的输入块、图片路径进入粘贴缓冲；100 ms 静默后合并处理。同步 pending 标志覆盖“粘贴与 Enter 同批到达”，避免用尚未提交的 UI 状态作判断。未标记的小块逐字粘贴存在终端协议无法消除的歧义，验收时如实记录。
4. **草稿**：短粘贴在光标处插入；超过 800 字符或显示行数限制的粘贴显示 `[Pasted text #N…]`，原文放在 `pastedContents`。图片显示 `[Image #N]`，与图片内容同属草稿状态。删除图片引用时移除附件；撤销同时恢复文字、光标与引用数据。
5. **提交**：输入组件只提交草稿快照。REPL 接收后展开文本引用、只发送仍被引用的图片；单行斜杠命令走命令分发，普通输入走 `Harness.prompt`。粘贴占位符不能被原样发给模型。图片不能跨 `/new`、`/resume` 等命令残留到下一条消息。
6. **非 TTY**：管道输入到 EOF 作为一次完整输入处理；不把其中的换行当成 Enter。该行为保留为本项目 CLI 的明确接口，并单独验收。

## 分批施工顺序

每批必须新增或完善一个主流程函数，明确它接收什么、如何调用配套功能、向外交付什么结果；期间更新的功能函数、必要类型和接线不计数量，不再按函数总数拆批。开始前先说明主流程函数、对照的 CC 函数、拟改的本项目文件和预期行为。完成后给出差异与验证结果，停下供用户 review。下一批只在用户要求后开始。

下面的“可略读”只提醒阅读重点：实现和验收仍要覆盖这些分支。每批围绕一个主流程函数讲来源、补齐配套功能、交付 review；进入非核心段落时提醒用户可以不逐行细看，不替用户改变阅读节奏。

| 批次 | 核心流程：需要能说清数据从哪来、到哪去 | 分支实现细节：协作时提醒可略读 | 主要源码对照 |
|---|---|---|---|
| 0（完成） | 旧输入退出运行入口，新输入从宿主重新接线；当时 `main.ts` 暂不可交互 | 五个旧文件当时先归档，本轮完成后删除 | Git 历史中的旧输入 |
| 1（完成） | 真实 stdin 只由宿主读取；raw mode 让字节及时到达；Ink 接虚拟 stdin、向 stdout 画界面；`rerender` 是后续状态更新的显示出口 | 终端能力检查、信号码、清理顺序与 bracketed paste 模式开关的逐行实现 | Ink `App.tsx` |
| 2（完成） | stdin 的任意字节块进入解析器，输出文字、按键或完整粘贴事件；跨 chunk 保留未完成内容，事件只从宿主发出 | 转义码分支表、UTF-8 拼接的字节下标、不同终端修饰键编码和异常序列恢复 | `tokenize.ts`、`parse-keypress.ts`、`input-event.ts` |
| 3（完成，已 review） | 一个输入事件按焦点和快捷键映射变成动作，再交给当前组件；纯解析及独立分发器已接入正式 REPL | 每组快捷键的具体写法、冲突排序和连续组合键的状态分支 | `use-input.ts`、`src/keybindings/*` |
| 4（完成） | `applyTextInputAction` 处理纯编辑；`TextInputController.handleAction` 将动作接入同步状态与 Enter/换行，`useTextInput` 订阅状态驱动 `BaseTextInput` 重画；`startTerminalTextInput` 连接宿主与分发器，交付提交快照 | 删除边界、Unicode 光标、屏幕折行、上下行目标列及显示投影 | `utils/Cursor.ts`、`useTextInput.ts`、`BaseTextInput.tsx` |
| 5（完成，已 review） | `PasteHandler.handleInput` 接收内容并合并粘贴，按序向控制器/图片回调交付；同步 pending 阻止同批 Enter 抢先提交，并覆盖异步图片读取 | 100 ms 合并计时、800 字符后备判断、异步剪贴板平台差异、图片 MIME/缩放及路径识别、失败回退与清理 | `usePasteHandler.ts`、`imagePaste.ts` |
| 6（完成，按要求提交） | `PromptInputController` 把可见文字、原始长文本与图片附件保持在同一份草稿；提交时交出完整快照；草稿变化驱动 `PromptInput` 更新 | 引用范围和编号、原子删除与移动、撤销/重做恢复的边界情况 | `PromptInput.tsx`、`useInputBuffer.ts` |
| 7（完成，按要求提交） | `preparePromptSubmission` 展开可信文本引用、筛选图片；`ReplController.submit` 分发命令或调用 Harness，事件经 Ink 显示；`runCli` 恢复入口 | 命令解析、会话选择、busy 门槛、退出清理及非 TTY 增量输出 | `handlePromptSubmit.ts`、`REPL.tsx` |
| 8（本地验收完成，实机跨平台待验收） | macOS 真实 PTY → 实际 Harness → 本地 HTTP SSE 请求与回复显示走通；`npm start` 已恢复 | Unicode 分片、组合键、resize、长文本/PNG 请求、信号/异常 termios 恢复及非 TTY EOF；真实剪贴板和其他平台需手测 | 完整输入链路 |

每批测试覆盖跨 chunk、粘贴加 Enter、修饰键冲突、长文本还原、删除图片引用、撤销恢复、非 TTY EOF；最终另做真实终端手测。本轮新增扩展测试按用户要求不提交。旧输入源码已删除，可从 Git 历史查阅，旧测试不再作为运行入口或验收命令。

## 当前代码边界

- `src/cli/ink/terminal-input.ts`：第 2 批事件解析；`StringDecoder` 保留跨字节 UTF-8，解析器保留跨 chunk 的转义序列和粘贴状态。保留 `raw`、键名及 Ctrl/Alt/Shift/Meta；其中 Alt 对应 CC `ParsedKey.meta`，Meta 对应 CC `ParsedKey.super`。响应和鼠标事件单独分流，目前上层尚不消费。
- `src/cli/input/keybindings.ts`：`matchesKeystroke()`、`matchesChord()`、`resolveKeybinding()` 纯解析键位与动作。聚焦上下文先于 Global；同上下文相同组合键以后置配置为准；长组合键优先于短前缀，null 覆盖消费按键。默认 Input 提供提交、换行、编辑、图片粘贴及撤销/重做；Global 提供中断/退出。`REPL_KEYBINDINGS` 将聚焦输入中的 Ctrl+D 覆盖为退出，独立基础编辑器仍保留 Ctrl+D 前向删除。按键映射与 REPL 动作实现分开。
- `src/cli/input/input-dispatcher.ts`：第 3 批第二小点，新增 `eventToKeystroke()`、`InputDispatcher.configure()` 和 `dispatch()`。调用方按焦点组件、外层、Global 排列 `InputTarget`；稳定的 `id: symbol` 区分同上下文的不同组件，动作处理器按命中的上下文选择首个目标，未消费的输入只交给首个焦点目标。组件身份、上下文顺序或绑定数组替换时清空 pending；仅更新处理器不清空。普通单码位 text（含 emoji）参与匹配，ASCII 大写保留 Shift，空格规范为 `space`；完整粘贴及多字符块不拆分，清空 pending 后原样交给焦点输入。响应和鼠标不进入组件，也不打断组合键。没有动作处理器或处理器同步返回 false 时，原始事件回到焦点输入。
- `src/cli/input/text-input-state.ts`：第 4 批的纯编辑状态与主流程。`TextInputState` 保存原始文本和按 UTF-16 下标表示的光标；`createTextInputState()` 限制位置范围并向左对齐字素边界。主流程 `applyTextInputAction()` 接收当前状态及 `TextInputAction`（插入、移动或删除），先校正光标，再调用对应功能函数并返回结果。`insertText()` 插入后重新分段，向右对齐到插入内容之后的有效边界；`moveCursor()` 每次越过一个完整字素；`moveVerticalCursor()` 接收调用方给出的 `availableColumns`，经共享布局定位屏幕行/列，再寻找相邻行中对应显示列的完整字素边界；首末行保持位置。`deleteText()` 删除光标前后相邻字素，在起点/末尾不越界，删除换行可合并两行。删除后重新分段并向左对齐，防止相邻文字合成新字素后光标落在内部。这层不识别终端按键、不维护快捷键映射、不渲染；Enter 由输入控制器处理，组件与分发器通过独立宿主适配器接线。
- `src/cli/input/text-input-layout.ts`：共享纯布局及行列互转。`layoutTextInput()` 接收原文和正整数可用列数，按完整字素及显示宽度折行，返回每行的原文起止下标、显示文本、宽度及字素边界映射；不读取终端宽度。LF、CRLF 和单独 CR 作为硬换行，连续/尾随换行保留空行，原文不做归一化。Tab 显示展开为 4 列制表位，窄行中限制到可用宽度；控制字符、孤立代理字符、单独零宽字素及宽于整行的字素仅在显示文本中用单列 `�` 替代，原文下标仍覆盖完整字素。`getTextInputPosition()` 将 UTF-16 光标下标映射为屏幕行/列，`getTextInputOffset()` 将目标行/列向左对齐到字素边界；软折行共享下标属于下一行，反向定位时不将它作为上一行的末尾。`splitTextInputLine()` 按显示列拆分完整显示字素，供组件反色显示光标；行末用预留列显示空格光标。
- `src/cli/input/text-input-controller.ts`：`handleAction()` 同步维护文本/光标并处理 Enter、换行及编辑；上下键只移动当前输入的屏幕行。`handleInput()` 接入粘贴处理器，pending 时提交动作被消费且不重放；`canSubmit()` 提供上层同步门槛。文本/图片回调交给 `PromptInputController`。精确 `TextInputEdit` 范围及 edit/cursor transform 让上层维护原子引用，不靠文字 diff 猜位置；撤销/重做交给上层。`replaceState()` 换草稿并取消旧粘贴，`restoreState()` 恢复撤销状态且保留之后排队的工作；`dispose()` 清理。
- `src/cli/input/paste-handler.ts`：第 5 批主流程 `handleInput()` 识别完整粘贴、大于 800 字符的块、图片路径及 pending 后续文字，100 ms 静默后合并处理。同步 pending 覆盖缓冲、排队动作及异步文件/剪贴板读取；编辑动作封口前面的文本并按事件顺序交付。空 macOS 图片粘贴单独进入剪贴板任务，不与紧随的文字合并。成功图片按原始位置交付，失败路径和其余正文保持原字节顺序；没有图片消费者时不读取文件，按正文交付。取消通过 generation 丢弃旧任务结果。
- `src/cli/input/use-text-input.ts`、`base-text-input.tsx`：`useSyncExternalStore` 订阅同步快照，按共享布局逐行渲染；光标按显示列拆分，并反色显示完整字素或展开后的一个 Tab 空格。每行使用 `truncate-end` 避免 Ink 二次折行。组件不使用 Ink `useInput`，不再读取 stdin；焦点由调用方配置分发目标，`focus` 属性控制光标显示。
- `src/cli/input/terminal-text-input.tsx`：`startTerminalTextInput()` 装配控制器、分发器和真实 stdin 宿主，向 Ink 提交基础组件，监听 stdout resize 更新可用列数。宿主 stop、EOF、close、异常及信号退出通过 `onStop` 清理控制器和 resize；异步交付回调报错先恢复终端再通知 `onPasteError`。该适配器不处理命令或模型，不进入当前 `main.ts`。
- `src/cli/input/prompt-draft.ts`：不可变完整草稿、可信引用范围及 `preparePromptSubmission()`；展开原始长文本一次，按当前引用顺序收集真实图片内容。用户手打同名占位符仍是普通正文。
- `src/cli/input/prompt-input-controller.ts`、`prompt-input.tsx`：上层持有文字、光标、引用、附件及最多 100 份撤销状态；短粘贴直接插入，长粘贴/图片生成引用；移动和删除保持引用完整。`PromptInput` 订阅快照并渲染基础编辑器与 pending 状态。
- `src/cli/repl/repl-controller.ts`、`terminal-repl.tsx`：同步接受/拒绝提交、命令与会话选择、Harness 事件投影及终端装配。接受后重置完整草稿；busy 时仍可编辑下一条，Enter 不排队。Ctrl+C 中断生成、清草稿或空闲退出，Ctrl+D 退出；宿主停止统一清理输入、订阅和 resize。
- `src/cli/utils/image-paste.ts`：第 5 批保序图片路径解析与异步图片文件/剪贴板读取；支持引号、转义空格、相对/绝对路径、`~/`、file URL 和 Windows 盘符/UNC。复用已有 PNG/JPEG/GIF/WebP MIME 与 APNG 拒绝，并检查基本容器/头部、有效尺寸和结束边界，拒绝截断文件；这不是完整像素解码。沿用 2000 边长缩放策略，源文件不修改。平台命令无 shell，受超时限制，临时目录始终清理。旧同步 `utils/image.ts` 已删除，新输入的快捷键统一由 `keybindings.ts` 提供。
- `src/harness/`：通过 `Harness.prompt(text, images)` 和事件订阅接入新 REPL；本轮补齐 prompt 全程及摘要请求的取消信号，涵盖 Agent 结束到自动压缩/重试之间的空档。`abort()` 同时取消 Agent 和摘要，中断后的摘要不替换历史、不写 compaction。Agent/LLM 协议实现本轮不改。
- `src/cli/main.ts`：`runCli()` 装配 Harness；TTY 进入新 REPL，非 TTY 保留 UTF-8 原文到 EOF 后提交一次。导入模块不启动进程；信号、异常和退出统一清理。

第 2 批对照的 CC 源码实际在本机 `/Users/kyson/workspace/claudecode fork/claude-code-rev`，HEAD 仍为 `3b0498a`。本项目与 CC 一样对不完整的普通转义序列等待 50 ms，对进行中的粘贴等待 500 ms 后恢复；单独 Esc 与分批送达的粘贴起始字节存在终端协议自身的时间歧义。X10 鼠标尾部按常见单字节坐标整体分流，尚未启用鼠标跟踪；高坐标的旧式 X10 编码没有真实终端验收。原临时解析探针的 6 例本轮复跑通过，按用户要求仍只保留在本地。

第 3 批第一小点对照 `keybindings/match.ts` 与 `resolver.ts::resolveKeyWithChordState`。还原源码的类型声明与调用方存在 `keys` / `chord`、`super` 等差异，本项目不直接复制它的类型；该小点已 review。

第二小点对照 `ink/hooks/use-input.ts`、`KeybindingProviderSetup.tsx::ChordInterceptor` / `KeybindingSetup.setPendingChord` 和 `useKeybinding.ts` 的动作处理。分发器同步保存 pending，不依赖 React 重画；纯 Esc 在 pending 中只取消组合键，其余无效后续键清空 pending 后重新独立解析，保证 Ctrl+C 或另一组组合键前缀可立即生效。沿用 CC 的 1000 ms 有效期，用单调时钟在下次用户输入时检查过期；当前没有 pending 提示 UI，无需持有定时器。后续若显示等待状态，需要同时设计该 UI 的过期更新。

第 3 批逻辑全部实现后，`npm run typecheck`、`npm run build` 和 10 个一次性内存探针通过。探针覆盖解析器事件进入默认动作、精确修饰键、同一动作换绑及 null 覆盖、连续组合键和接错重试、焦点优先级、同上下文组件切换、处理器更新、配置替换、Esc 取消、整块粘贴/长文字、响应/鼠标分流、Unicode、处理器拒绝与超时恢复。探针未写入仓库，未接真实终端或模型。第二小点已由用户逐段 review，并要求继续第 4 批。运行入口在第 7 批恢复。

第 4 批的状态与插入基础参考 CC `utils/Cursor.ts::Cursor.fromText`、`Cursor.insert` / `modifyText` 和 `MeasuredText.getGraphemeBoundaries`。使用 `Intl.Segmenter` 按字素簇找边界，避免拆开代理对、组合字符与 ZWJ emoji；边界下标仍对应 JavaScript 的 `slice()`。本项目保留原始文本，不像 CC 的 `MeasuredText` 做 NFC 归一化，避免改写粘贴原文。插入后可能与相邻字符形成新字素簇，因此重新分段并将光标放在插入内容之后的有效边界。

插入、左右移动与删除小批增加主流程 `applyTextInputAction()`，配套功能参考 CC `Cursor.left/right/backspace/del`：先找相邻完整字符边界，再移动或删除该范围。主流程是本项目的纯函数入口，由同步控制器持有状态并调用，React hook 订阅其结果；不照搬 CC 的 Cursor 类或图片引用处理，引用与附件仍属于第 6 批。该小批 `npm run typecheck` 和 `npm run build` 通过，已由用户逐段 review 并要求提交。

2026-10-05 的上下移动小批完善同一主流程，参考 `utils/Cursor.ts::Cursor.up/down`、`MeasuredText.measureWrappedText`、`getPositionFromOffset` 与 `getOffsetFromPosition`。调用方传入的 `availableColumns` 已扣除提示符、边框及光标所需列数，布局函数不再像 CC `Cursor.fromText` 那样额外减一列。每次上下移动使用当前显示列；沿用 CC 不保存理想列的行为，经过短行后继续移动时以短行落点为准。纯编辑函数在首末行返回原位置；控制器直接调用纯编辑函数，首末行保持当前光标。共享布局保留每个硬换行和空行，不需要另加逻辑行回退。

本项目的显示策略是保留空白并按字素满列折行，与 CC 的 `wrapAnsi` 按空格断词、软折行开头 `trimStart` 和渲染末尾 `trimEnd` 不同。软折行下标归下一行；目标行是软折行时，最后可达位置是该行最后一个字素之前，避免反向定位后光标又落回下一行。Ink 6.5.1 会为单独零宽字素分配至少一格，因此显示投影将这些字素与孤立代理字符替换为单列 `�`，保持测量与渲染一致；正常组合字符与 ZWJ emoji 仍完整显示。基础组件直接消费共享布局的显示行及行列位置，避免 Ink 二次折行；光标按显示列拆分显示文本。Tab 展开和替代字符仅用于显示，不作为提交内容。

第 4 批完整实现后新增持久测试 `npm run test:input`，覆盖字素编辑、换行与屏幕移动、同批文字加 Enter、精确修饰键、上下移动边界、焦点及换绑、同步提交门槛、真实 Ink 渲染与模拟 TTY 的宿主清理。接线时修复 CSI-u/modifyOtherKeys 的补充平面文字与小键盘数字丢失，并拒绝孤立代理编码；原来的范围判断会漏掉 emoji。类型检查与构建通过；测试具体结果见进度页。尚未连接模型，实际 Windows/WebStorm/Terminal.app 手测仍属于第 8 批。

本批参考 CC `useTextInput::handleEnter`、`Cursor.up/down` 和 `BaseTextInput`。本项目通过独立同步控制器及 `useSyncExternalStore` 避免同批事件读取旧 React 状态；CC 的文本 hook 使用回调/refs。本项目只采用编辑、换行和基础显示链路；模式筛选、kill ring、搜索、提示和定制 Ink 光标声明不在当前实现范围。附件与撤销现由完整草稿层接入，宿主/REPL 显示协调已通过本轮本地 PTY 验收。

## 第 5 批实现与取舍

参考本机 `/Users/kyson/workspace/claudecode fork/claude-code-rev/src/hooks/usePasteHandler.ts::wrappedOnInput`、`resetPasteTimeout` 和 `src/utils/imagePaste.ts` 的路径、文件与剪贴板读取链路。本项目沿用明确粘贴优先、严格大于 800 字符的后备判断和 100 ms 静默合并；用独立同步 `PasteHandler` 保存 pending 与队列，React 只订阅控制器快照，不再新增 stdin 监听器。

与参考实现的取舍：

- pending 在图片读取和交付回调结束前保持为 true，Enter 只消费当前动作，完成后不会自动发送。方向、删除和换行动作先封口前面的文本，必要时排在异步图片之后，防止光标移动造成内容乱序。
- macOS 空 bracketed paste 独立触发图片剪贴板读取，紧随的普通文字排在图片之后；失效的系统临时截图路径也可回退到剪贴板。其他平台使用集中映射的 `input:paste-image`：Windows 默认 Alt+V，其他平台 Ctrl+V。已有动作换绑只改 `keybindings.ts` 的映射。
- 图片路径按原文片段解析，只消费成功读取的路径；失败路径、引号、转义、CRLF、Tab 和其余正文保持顺序。不复制 CC 的末尾 `[I`/`[O` 删除正则，避免误改合法正文；也不复制其混合图片分支按扩展名过滤失败路径的行为。
- 图片结果为 `PastedImage`（内容块和可选文件名/来源路径），通过 `onImagePaste` 交付。第 5 批不保存独立附件列表；第 6 批再把占位符、原始文本、图片和撤销放入同一份草稿。
- 图片采集与缩放使用异步文件/进程 API，命令不通过 shell；剪贴板采集命令共享 8 秒预算，缩放命令单次超时 8 秒。复用本项目 MIME 判别与最长边 2000 的既有策略，另检查 PNG/JPEG/GIF/WebP 基本容器结构；截断文件读取失败，合法原图缩放失败则保留原字节。这不包含完整像素解码或 CRC 检查，不引入 CC native 模块、sharp、BMP 转换或 5 MB 压缩策略。私有临时目录在成功与失败分支都清理，原图片不修改。
- `replaceState()` 与 stop/dispose 取消定时器并更换 generation，旧读取即使完成也不能写回下一份草稿，也不再启动新的剪贴板回退。回调中停止或换草稿后，剩余图片/文本/动作也不再交付。宿主自身的 EOF、close、异常及信号退出同样通知控制器清理。

第 5 批整体实现后，`npm run test:input` 68 项、`npm run typecheck`、`npm run build` 和 `git diff --check` 通过。新增持久测试覆盖 100 ms/800 边界、同批 Enter、异步图片门槛与事件顺序、空图片粘贴后立即打字、混合成功/失败路径、草稿替换、回调重入、异常、停止与 EOF。图片工具测试读取有效小 PNG/JPEG/GIF/WebP 和动画 WebP，拒绝截断/越界容器，并验证坏图片路径作为原始正文交付；PATH 假命令覆盖带空格的剪贴板路径、缩放失败保留原图和临时目录清理。独立探针验证实际 macOS `sips` 将 4000×100 PNG 缩为 2000×50 且不改源图；Windows/Linux 命令链通过模拟验证。没有读取真实剪贴板或调用模型。Windows/Linux 原生剪贴板、各终端粘贴快捷键与最终模型请求仍待第 8 批真实环境验收。

## 第 6–8 批实现与验收

本轮按用户要求把剩余输入功能一次性完成，保留第 1–5 批底座。源码参考本地 CC `PromptInput.tsx`、`useInputBuffer.ts` 及 `handlePromptSubmit.ts` 的草稿、附件引用、撤销和提交前展开行为；本项目用同步控制器承接这些职责，不复制其完整 REPL 或定制 Ink。

主流程 `PromptInputController` 将粘贴交付变成草稿编辑：不超过 800 字符且最多占 2 个显示行时插入原文，超过任一门槛生成 `[Pasted text #N +M lines]`；图片生成 `[Image #N]`，真实 Base64/MIME 内容放入同份草稿。`references` 记录创建时的精确范围，编辑器把引用当完整单元移动和删除，`pastedContents` 只保留仍有引用的内容。引用编号在当前草稿中单调增加，撤销后新粘贴不会误用旧编号。

与仅通过标签匹配查找附件的实现不同，本项目只展开草稿中可信的范围引用。用户手打或复制相同标签保持原文；长文本只展开一遍，不递归解释其内部的标签。`preparePromptSubmission()` 按当前引用顺序收集图片，删除引用后提交不会携带它。撤销/重做最多保存 100 份完整草稿，文字、光标、引用及附件一起恢复；上下键不召回历史输入。重置/接受提交后清理整份草稿并取消旧异步结果，停止后 pending 快照恢复为 false。

`ReplController.submit()` 先同步检查 closed/busy、文本或图片有效性，再接受并清理编辑器；单行已知命令走 REPL，其他内容交给 `Harness.prompt(text, images)`。`/resume` 先显示会话列表，再接收序号；空行取消，非法序号保留选择器，选择按已展示文件身份定位，避免排序变化选错。`/resume 2` 仍作为普通正文。`/new`、`/resume`、`/context`、`/compact`、`/help`、`/exit` 接回既有 Harness 行为。busy 时可以编辑下一条，Enter 被消费且不排队自动提交；失败释放门槛，下一轮可以继续。

`startTerminalRepl()` 把完整输入目标和 Global 动作交给同一个分发器。Ctrl+C 在生成时中断，空闲有草稿/粘贴时清理，空闲空草稿时退出；Ctrl+D 退出。`ReplView` 以 Ink `Static` 显示完成条目，动态区域显示当前回复和输入。入口 `runCli()` 仅在 stdin/stdout 都是 TTY 时启用编辑器；管道到 EOF 才提交一次，换行和 Tab 保留，不回显用户正文。

本轮曾通过扩展 `test:input` 运行 115 项本机测试，覆盖解析、字素编辑、布局、粘贴/图片、完整草稿、引用删除/撤销、组件、命令和入口。提交时按用户要求排除所有新增测试，脚本恢复为已有的 68 项基础回归；类型检查与构建仍使用 `npm run typecheck`、`npm run build`。本地 PTY 辅助配合 7 项终端/入口验收验证跨字节 Unicode、编辑与换行、粘贴同批 Enter、改绑/组合键、80→12 列 resize、唯一 stdin 监听、停止/信号/回调异常的完整 termios 恢复，以及非 TTY EOF；这些扩展用例和辅助脚本不随本次提交提供。

端到端请求通过实际 Harness 与本地 HTTP SSE 服务：超过 800 字符的原文及有效 PNG 路径粘贴后，输入显示占位符，模型请求包含完整原文和精确 `data:image/png;base64,...`，不发送占位符或输入文件路径；`/new` 不残留附件，实时回复最终只显示一份。另验证 busy 中断后续聊、真实 HTTP 错误恢复、会话恢复、摘要写入 compaction 行及下一轮请求使用摘要/保留尾部。所有会话与图片测试数据放在临时目录。

最终 review 发现摘要请求未沿用 Agent 的取消信号，本轮在 Harness 补齐取消范围。新增 5 项回归覆盖手动压缩中断/退出、自动阈值和溢出摘要中断、Agent 结束时中断、摘要转换期间中断、provider 忽略 signal 的晚到成功结果；真实 HTTP 连接取消后释放 busy，历史和会话不写入已取消的摘要，下一轮仍可用。

本地自动验收不代表各平台实机验收。Windows/Linux 原生终端与剪贴板、WebStorm/macOS Terminal 的实际按键及粘贴行为仍需手测；没有调用真实模型或读取真实系统剪贴板。无标记的小块慢速粘贴、终端无法区分的修饰键，仍受前述协议边界约束。

本轮 review 可按实际调用顺序：`main.ts::runCli` → `terminal-repl.tsx::startTerminalRepl` → `PromptInputController` 构造和粘贴/编辑回调 → `repl-controller.ts::submit` → `prompt-draft.ts::preparePromptSubmission` → `Harness.prompt`；显示再看 `ReplView` 和 `PromptInput`。底层控制器新增的精确编辑范围、引用 transform 和 undo/redo 接口，在上层调用到它们时一起看；Harness 新增部分只需重点检查摘要取消及中断后的历史保护。
