# Claude Code 输入架构迁移计划

## 当前状态与目标

2026-10-07：旧输入已归档，`main.ts` 仍断开交互输入。第 1–4 批已完成；第 5 批已整批实现粘贴缓冲、同步 pending 提交门槛、图片路径/剪贴板异步读取及生命周期清理，并经用户 review 确认。`npm run test:input` 的 68 项新输入行为测试通过，`npm run test:input:stash` 只验证归档代码。第 6–8 批的完整附件草稿、REPL/Harness 接线与最终终端验收仍待推进，`npm start` 继续提示入口不可用。

目标是按本地 `claude-code-rev` 的输入链路重建终端交互：**一个 stdin 所有者 → 按键/粘贴事件 → 聚焦的文本输入组件 → 草稿及附件状态 → 提交给 Harness**。逐层对齐 CC 的事件语义、粘贴行为、编辑行为和快捷键分发。每次按用户指定范围交付可 review 的实现，确认后再进入下一批；本次第五批按用户要求一次性完成。

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

输入主链路（第 1–5 批已通过独立基础输入接通到文本快照及图片回调；PromptInput、REPL 及运行入口仍待后续批次）：

```text
stdin (唯一读取者)
  → 终端协议解析 / InputEvent（完整粘贴带 isPasted）
  → 焦点与快捷键分发
  → TextInputController.handleInput → PasteHandler：普通内容直接编辑，粘贴合并后交付文本/图片
  → TextInputController.handleAction：pending 时拦住提交，编辑按序处理
  → useTextInput → BaseTextInput 重画（同步快照含 isPasting）
  → 后续第 6 批：PromptInput 草稿文字 + pastedContents + 光标/撤销
  → 后续第 7 批提交边界：展开文本引用、收集仍被引用的图片
  → REPL 命令分发 / Harness.prompt(text, images)
```

显示主链路也要在接线时讲清：编辑器的草稿状态变化 → React/Ink 重画输入组件 → stdout 显示；提交后 `Harness.subscribe` 收到 Agent 事件 → REPL 更新显示内容 → Ink 重画或采用与 Ink 协调的输出方式 → stdout 显示。现有 `src/cli/render.ts` 会直接写 stdout；第 7 批接 REPL 时需要明确它与 Ink 的边界，避免两处同时随意改写终端画面。具体显示方式在该批 review 时确定，当前尚未接通。

预期文件边界（文件名可在对应批次 review 时按依赖调整）：

```text
src/cli/ink/       terminal host、tokenizer、parse-keypress、InputEvent、useInput
src/cli/input/     keybindings、useTextInput、BaseTextInput、usePasteHandler、PromptInput、useInputBuffer
src/cli/repl/      提交展开、命令路由、Harness 接线
src/cli/input/stash/  旧输入快照，不参与新运行链路
```

### 解耦约束与快捷键验收

这是本次重制的完成条件，也是后续 TUI 继续使用这套输入底座的边界：

- 终端层只产出保留键名、修饰键、文本和粘贴标记的事件，不知道 `/new`、提交、Harness 等业务动作；焦点分发也不解析业务命令。
- 快捷键层集中维护“按键或连续组合键 + 上下文 → 动作”的映射及优先级。输入组件注册编辑动作，REPL/TUI 注册各自的上层动作；按键写法不散落在组件和 `main.ts` 的条件分支中。
- 输入组件维护草稿和编辑状态，向上层交付完整草稿快照或明确的动作。上层只消费这些结果，不读取原始 stdin、转义序列或光标内部状态。
- 给**已有动作**增加另一种可识别的组合键，只改快捷键映射；增加**新动作**，只增加映射及对应层的处理器，不重写终端解析、焦点分发、草稿和提交链路。连续组合键由同一个解析器处理，不为每组键另建一条输入链路。
- 第 3 批用“同一动作换绑另一组键”“连续组合键”“不同焦点下同键不同动作”验证分发契约；第 8 批接上 REPL 后，再验证新增一个上层快捷键不需要修改终端层或编辑器。真实终端无法区分、或尚未上报的组合键，需要在终端协议解析处做局部适配，并记录该终端的限制；不承诺终端本身无法提供的按键信息。

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
| 0（完成） | 旧输入退出运行入口，新输入从宿主重新接线；确认 `main.ts` 暂不可交互 | 五个旧文件的搬移和旧 import 清理 | 旧 `src/cli/input/stash/` |
| 1（完成） | 真实 stdin 只由宿主读取；raw mode 让字节及时到达；Ink 接虚拟 stdin、向 stdout 画界面；`rerender` 是后续状态更新的显示出口 | 终端能力检查、信号码、清理顺序与 bracketed paste 模式开关的逐行实现 | Ink `App.tsx` |
| 2（完成） | stdin 的任意字节块进入解析器，输出文字、按键或完整粘贴事件；跨 chunk 保留未完成内容，事件只从宿主发出 | 转义码分支表、UTF-8 拼接的字节下标、不同终端修饰键编码和异常序列恢复 | `tokenize.ts`、`parse-keypress.ts`、`input-event.ts` |
| 3（逻辑完成，已 review） | 一个输入事件按焦点和快捷键映射变成动作，再交给当前组件；纯解析及独立分发器已实现，真实组件接线随后续批次完成 | 每组快捷键的具体写法、冲突排序和连续组合键的状态分支 | `use-input.ts`、`src/keybindings/*` |
| 4（完成） | `applyTextInputAction` 处理纯编辑；`TextInputController.handleAction` 将动作接入同步状态与 Enter/换行，`useTextInput` 订阅状态驱动 `BaseTextInput` 重画；`startTerminalTextInput` 连接宿主与分发器，交付提交快照 | 删除边界、Unicode 光标、屏幕折行、上下行目标列及显示投影 | `utils/Cursor.ts`、`useTextInput.ts`、`BaseTextInput.tsx` |
| 5（完成，已 review） | `PasteHandler.handleInput` 接收内容并合并粘贴，按序向控制器/图片回调交付；同步 pending 阻止同批 Enter 抢先提交，并覆盖异步图片读取 | 100 ms 合并计时、800 字符后备判断、异步剪贴板平台差异、图片 MIME/缩放及路径识别、失败回退与清理 | `usePasteHandler.ts`、`imagePaste.ts` |
| 6 | `PromptInput` 把可见文字、原始长文本与图片附件保持在同一份草稿；提交时交出完整快照；草稿变化驱动界面更新 | 占位符编号和显示格式、删除引用的清理分支、撤销恢复的边界情况 | `PromptInput.tsx`、`useInputBuffer.ts` |
| 7 | 草稿快照进入 REPL；展开文本引用、筛选图片后分发命令或调用 `Harness.prompt`；Agent 事件进入显示链路，最终到 stdout | 各条斜杠命令的具体解析、附件筛选循环、退出和异常清理的分支；本批需确定现有直接写 stdout 的 `renderEvent` 如何与 Ink 配合 | `handlePromptSubmit.ts`、`REPL.tsx` |
| 8 | 从真实终端输入到模型请求，再从 Agent 事件到终端显示，走通整条链；验收后恢复 `npm start` | 各终端按键编码差异、粘贴和图片的特殊组合、验收脚本与文档更新的逐项细节 | 完整输入链路 |

每批的测试只覆盖该层最容易出错的契约：跨 chunk、粘贴加 Enter、修饰键冲突、长文本还原、删除图片引用、撤销恢复、非 TTY EOF。最终另做真实终端手测。旧 `stash` 代码和测试只用于对照，不进入新入口。

## 当前代码边界

- `src/cli/ink/terminal-input.ts`：第 2 批事件解析；`StringDecoder` 保留跨字节 UTF-8，解析器保留跨 chunk 的转义序列和粘贴状态。保留 `raw`、键名及 Ctrl/Alt/Shift/Meta；其中 Alt 对应 CC `ParsedKey.meta`，Meta 对应 CC `ParsedKey.super`。响应和鼠标事件单独分流，目前上层尚不消费。
- `src/cli/input/keybindings.ts`：第 3 批第一小点，新增 `matchesKeystroke()`、`matchesChord()`、`resolveKeybinding()` 及必要类型。上下文由调用方按优先级传入（聚焦上下文在 Global 前），同上下文相同组合键以后置配置为准；长组合键优先于其短前缀，null 覆盖消费按键且不会单独启动长组合键等待。纯解析只返回动作名或 pending / cancelled / unbound / none，不读取 stdin、不调用编辑器或 Harness。默认 `Input` 映射 Enter 为 `input:submit`，Shift/Alt/Meta+Enter 及可识别的 Ctrl+J 为 `input:newline`；`Global` 的 Ctrl+C 为 `app:interrupt`。第 4 批补齐方向、前后删除、Home/End 及对应 Ctrl 快捷键映射，动作由输入控制器处理；中断仍由后续 REPL 处理。
- `src/cli/input/input-dispatcher.ts`：第 3 批第二小点，新增 `eventToKeystroke()`、`InputDispatcher.configure()` 和 `dispatch()`。调用方按焦点组件、外层、Global 排列 `InputTarget`；稳定的 `id: symbol` 区分同上下文的不同组件，动作处理器按命中的上下文选择首个目标，未消费的输入只交给首个焦点目标。组件身份、上下文顺序或绑定数组替换时清空 pending；仅更新处理器不清空。普通单码位 text（含 emoji）参与匹配，ASCII 大写保留 Shift，空格规范为 `space`；完整粘贴及多字符块不拆分，清空 pending 后原样交给焦点输入。响应和鼠标不进入组件，也不打断组合键。没有动作处理器或处理器同步返回 false 时，原始事件回到焦点输入。
- `src/cli/input/text-input-state.ts`：第 4 批的纯编辑状态与主流程。`TextInputState` 保存原始文本和按 UTF-16 下标表示的光标；`createTextInputState()` 限制位置范围并向左对齐字素边界。主流程 `applyTextInputAction()` 接收当前状态及 `TextInputAction`（插入、移动或删除），先校正光标，再调用对应功能函数并返回结果。`insertText()` 插入后重新分段，向右对齐到插入内容之后的有效边界；`moveCursor()` 每次越过一个完整字素；`moveVerticalCursor()` 接收调用方给出的 `availableColumns`，经共享布局定位屏幕行/列，再寻找相邻行中对应显示列的完整字素边界；首末行保持位置。`deleteText()` 删除光标前后相邻字素，在起点/末尾不越界，删除换行可合并两行。删除后重新分段并向左对齐，防止相邻文字合成新字素后光标落在内部。这层不识别终端按键、不维护快捷键映射、不渲染；Enter 由输入控制器处理，组件与分发器通过独立宿主适配器接线。
- `src/cli/input/text-input-layout.ts`：共享纯布局及行列互转。`layoutTextInput()` 接收原文和正整数可用列数，按完整字素及显示宽度折行，返回每行的原文起止下标、显示文本、宽度及字素边界映射；不读取终端宽度。LF、CRLF 和单独 CR 作为硬换行，连续/尾随换行保留空行，原文不做归一化。Tab 显示展开为 4 列制表位，窄行中限制到可用宽度；控制字符、孤立代理字符、单独零宽字素及宽于整行的字素仅在显示文本中用单列 `�` 替代，原文下标仍覆盖完整字素。`getTextInputPosition()` 将 UTF-16 光标下标映射为屏幕行/列，`getTextInputOffset()` 将目标行/列向左对齐到字素边界；软折行共享下标属于下一行，反向定位时不将它作为上一行的末尾。`splitTextInputLine()` 按显示列拆分完整显示字素，供组件反色显示光标；行末用预留列显示空格光标。
- `src/cli/input/text-input-controller.ts`：第 4 批动作主流程 `handleAction()` 同步持有文本/光标快照，调用纯编辑函数；上下键只移动当前输入的屏幕行，首末行保持位置。普通提交动作交付快照；多行模式下反斜杠加 Enter 替换反斜杠为 LF，Shift/Alt/Meta+Enter 及可识别的 Ctrl+J 插入 LF。第 5 批将 `handleInput()` 接入粘贴处理器，pending 时提交动作被消费且不重放；`canSubmit()` 继续提供上层同步门槛，`onPaste` 接收合并后的粘贴事件，不存在回调时直接插入文本。`onImagePaste` 只向后续附件层交付结果，本层不另存附件。`insertText()` 允许交付回调在当前光标处插入内容并保留后续有序结果；`replaceState()` 替换整份草稿并取消旧粘贴，`dispose()` 使输入失效并清理。
- `src/cli/input/paste-handler.ts`：第 5 批主流程 `handleInput()` 识别完整粘贴、大于 800 字符的块、图片路径及 pending 后续文字，100 ms 静默后合并处理。同步 pending 覆盖缓冲、排队动作及异步文件/剪贴板读取；编辑动作封口前面的文本并按事件顺序交付。空 macOS 图片粘贴单独进入剪贴板任务，不与紧随的文字合并。成功图片按原始位置交付，失败路径和其余正文保持原字节顺序；没有图片消费者时不读取文件，按正文交付。取消通过 generation 丢弃旧任务结果。
- `src/cli/input/use-text-input.ts`、`base-text-input.tsx`：`useSyncExternalStore` 订阅同步快照，按共享布局逐行渲染；光标按显示列拆分，并反色显示完整字素或展开后的一个 Tab 空格。每行使用 `truncate-end` 避免 Ink 二次折行。组件不使用 Ink `useInput`，不再读取 stdin；焦点由调用方配置分发目标，`focus` 属性控制光标显示。
- `src/cli/input/terminal-text-input.tsx`：`startTerminalTextInput()` 装配控制器、分发器和真实 stdin 宿主，向 Ink 提交基础组件，监听 stdout resize 更新可用列数。宿主 stop、EOF、close、异常及信号退出通过 `onStop` 清理控制器和 resize；异步交付回调报错先恢复终端再通知 `onPasteError`。该适配器不处理命令或模型，不进入当前 `main.ts`。
- `src/cli/input/stash/`：历史快照，不作为新输入的实现起点。
- `src/cli/utils/image-paste.ts`：第 5 批保序图片路径解析与异步图片文件/剪贴板读取；支持引号、转义空格、相对/绝对路径、`~/`、file URL 和 Windows 盘符/UNC。复用已有 PNG/JPEG/GIF/WebP MIME 与 APNG 拒绝，并检查基本容器/头部、有效尺寸和结束边界，拒绝截断文件；这不是完整像素解码。沿用 2000 边长缩放策略，源文件不修改。平台命令无 shell，受超时限制，临时目录始终清理。旧 `image.ts` 保留给归档代码，新输入不调用它的同步剪贴板或按键判断。
- `src/harness/`、`src/agent/`、`src/llm/`：本次不改。它们只在第 7 批通过明确的提交结果接入。
- `src/cli/main.ts`：目前仅保留 Harness 装配并报告交互入口不可用。新输入完成前不提供临时 readline 或旧 `CliPrompt` 回退。

第 2 批对照的 CC 源码实际在本机 `/Users/kyson/workspace/claudecode fork/claude-code-rev`，HEAD 仍为 `3b0498a`。本项目与 CC 一样对不完整的普通转义序列等待 50 ms，对进行中的粘贴等待 500 ms 后恢复；单独 Esc 与分批送达的粘贴起始字节存在终端协议自身的时间歧义。X10 鼠标尾部按常见单字节坐标整体分流，尚未启用鼠标跟踪；高坐标的旧式 X10 编码没有真实终端验收。临时探针 `test/terminal-parser.test.ts`（目录被忽略）6 例通过，`npm run typecheck` 和 `npm run build` 通过。

第 3 批第一小点对照 `keybindings/match.ts` 与 `resolver.ts::resolveKeyWithChordState`。还原源码的类型声明与调用方存在 `keys` / `chord`、`super` 等差异，本项目不直接复制它的类型；该小点已 review。

第二小点对照 `ink/hooks/use-input.ts`、`KeybindingProviderSetup.tsx::ChordInterceptor` / `KeybindingSetup.setPendingChord` 和 `useKeybinding.ts` 的动作处理。分发器同步保存 pending，不依赖 React 重画；纯 Esc 在 pending 中只取消组合键，其余无效后续键清空 pending 后重新独立解析，保证 Ctrl+C 或另一组组合键前缀可立即生效。沿用 CC 的 1000 ms 有效期，用单调时钟在下次用户输入时检查过期；当前没有 pending 提示 UI，无需持有定时器。后续若显示等待状态，需要同时设计该 UI 的过期更新。

第 3 批逻辑全部实现后，`npm run typecheck`、`npm run build` 和 10 个一次性内存探针通过。探针覆盖解析器事件进入默认动作、精确修饰键、同一动作换绑及 null 覆盖、连续组合键和接错重试、焦点优先级、同上下文组件切换、处理器更新、配置替换、Esc 取消、整块粘贴/长文字、响应/鼠标分流、Unicode、处理器拒绝与超时恢复。探针未写入仓库，未接真实终端或模型。第二小点已由用户逐段 review，并要求继续第 4 批。运行入口在第 7 批恢复。

第 4 批的状态与插入基础参考 CC `utils/Cursor.ts::Cursor.fromText`、`Cursor.insert` / `modifyText` 和 `MeasuredText.getGraphemeBoundaries`。使用 `Intl.Segmenter` 按字素簇找边界，避免拆开代理对、组合字符与 ZWJ emoji；边界下标仍对应 JavaScript 的 `slice()`。本项目保留原始文本，不像 CC 的 `MeasuredText` 做 NFC 归一化，避免改写粘贴原文。插入后可能与相邻字符形成新字素簇，因此重新分段并将光标放在插入内容之后的有效边界。

插入、左右移动与删除小批增加主流程 `applyTextInputAction()`，配套功能参考 CC `Cursor.left/right/backspace/del`：先找相邻完整字符边界，再移动或删除该范围。主流程是本项目的纯函数入口，由同步控制器持有状态并调用，React hook 订阅其结果；不照搬 CC 的 Cursor 类或图片引用处理，引用与附件仍属于第 6 批。该小批 `npm run typecheck` 和 `npm run build` 通过，已由用户逐段 review 并要求提交。

2026-10-05 的上下移动小批完善同一主流程，参考 `utils/Cursor.ts::Cursor.up/down`、`MeasuredText.measureWrappedText`、`getPositionFromOffset` 与 `getOffsetFromPosition`。调用方传入的 `availableColumns` 已扣除提示符、边框及光标所需列数，布局函数不再像 CC `Cursor.fromText` 那样额外减一列。每次上下移动使用当前显示列；沿用 CC 不保存理想列的行为，经过短行后继续移动时以短行落点为准。纯编辑函数在首末行返回原位置；控制器直接调用纯编辑函数，首末行保持当前光标。共享布局保留每个硬换行和空行，不需要另加逻辑行回退。

本项目的显示策略是保留空白并按字素满列折行，与 CC 的 `wrapAnsi` 按空格断词、软折行开头 `trimStart` 和渲染末尾 `trimEnd` 不同。软折行下标归下一行；目标行是软折行时，最后可达位置是该行最后一个字素之前，避免反向定位后光标又落回下一行。Ink 6.5.1 会为单独零宽字素分配至少一格，因此显示投影将这些字素与孤立代理字符替换为单列 `�`，保持测量与渲染一致；正常组合字符与 ZWJ emoji 仍完整显示。基础组件直接消费共享布局的显示行及行列位置，避免 Ink 二次折行；光标按显示列拆分显示文本。Tab 展开和替代字符仅用于显示，不作为提交内容。

第 4 批完整实现后新增持久测试 `npm run test:input`，覆盖字素编辑、换行与屏幕移动、同批文字加 Enter、精确修饰键、上下移动边界、焦点及换绑、同步提交门槛、真实 Ink 渲染与模拟 TTY 的宿主清理。接线时修复 CSI-u/modifyOtherKeys 的补充平面文字与小键盘数字丢失，并拒绝孤立代理编码；原来的范围判断会漏掉 emoji。类型检查与构建通过；测试具体结果见进度页。尚未连接模型，实际 Windows/WebStorm/Terminal.app 手测仍属于第 8 批。

本批参考 CC `useTextInput::handleEnter`、`Cursor.up/down` 和 `BaseTextInput`。本项目通过独立同步控制器及 `useSyncExternalStore` 避免同批事件读取旧 React 状态；CC 的文本 hook 使用回调/refs。本项目只采用编辑、换行和基础显示链路；模式筛选、kill ring、搜索、提示和定制 Ink 光标声明不在当前实现范围。附件与撤销沿第 6 批接入，最终宿主/REPL 显示协调在第 7–8 批验收。

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
