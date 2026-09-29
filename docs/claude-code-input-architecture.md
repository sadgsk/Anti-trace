# Claude Code 输入架构迁移计划

## 当前状态与目标

2026-09-29：旧输入的五个实现文件已移到 `src/cli/input/stash/`，`main.ts` 已断开交互输入。`npm start` 此时应明确提示入口不可用；这不是新输入已实现。旧测试只验证归档代码，运行命令为 `npm run test:input:stash`。

目标是按本地 `claude-code-rev` 的输入链路重建终端交互：**一个 stdin 所有者 → 按键/粘贴事件 → 聚焦的文本输入组件 → 草稿及附件状态 → 提交给 Harness**。逐层对齐 CC 的事件语义、粘贴行为、编辑行为和快捷键分发。每次只实现一个可 review 的小点，用户确认后再进入下一点；不批量复制整套 TUI。

CC 使用 React 组件和仓库内的定制 Ink。新输入也按这两层组织：终端事件与渲染宿主在 `src/cli/ink/`，输入组件在 `src/cli/input/`，REPL 的命令及 Harness 接线在 `src/cli/repl/`。第 1 批先核对定制 Ink 的最小依赖和本项目 Node/TypeScript 配置，建立一个可渲染的空宿主；不能假定 npm 上的普通 Ink 与 CC 的输入事件行为相同。后续只移植本项目需要的输入链路，每次给出对应源码和差异。

对照源码：`/Users/kyson/workspace/claudecode fork/claude-code-rev`，检查时 HEAD 为 `3b0498a`。该仓库自述为从 source map 还原、含 shim 的源码树，并非官方原始仓库。每一步以文中列出的具体文件为阅读入口；发现该还原版与实际依赖接口冲突时，先记录差异，再决定项目中的实现。

## 对照关系与职责

| CC 源码入口 | 本项目目标职责 |
|---|---|
| `src/ink/components/App.tsx`、`src/ink/parse-keypress.ts`、`src/ink/termio/tokenize.ts` | 唯一 stdin 读取者；raw mode、bracketed paste、终端能力和清理；跨 chunk 解析为带修饰键的按键、文本或完整粘贴事件 |
| `src/ink/events/input-event.ts`、`src/ink/hooks/use-input.ts` | 统一事件对象；按聚焦状态分发，不给输入组件另设竞争性的 stdin 监听器 |
| `src/keybindings/*` | 将键值、修饰键、上下文和动作分开；处理冲突、优先级与组合键；输入组件只实现动作 |
| `src/hooks/useTextInput.ts`、`src/components/BaseTextInput.tsx` | 文本、光标、多行、历史和 Enter 行为；基础输入组件连接事件与编辑状态 |
| `src/hooks/usePasteHandler.ts`、`src/utils/imagePaste.ts` | 明确粘贴优先；拼接连续片段；处理图片剪贴板与图片路径 |
| `src/components/PromptInput/PromptInput.tsx`、`src/hooks/useInputBuffer.ts` | 提示词草稿、粘贴文本及图片引用、撤销、历史、显示和提交门槛 |
| `src/history.ts`、`src/utils/handlePromptSubmit.ts`、`src/screens/REPL.tsx` | 提交前展开文本引用、筛出已删除的图片、命令分发并调用 Harness |

数据流：

```text
stdin (唯一读取者)
  → 终端协议解析 / InputEvent（完整粘贴带 isPasted）
  → 焦点与快捷键分发
  → BaseTextInput：usePasteHandler → useTextInput
  → PromptInput：草稿文字 + pastedContents + 光标/历史/撤销
  → 提交边界：展开文本引用、收集仍被引用的图片
  → REPL 命令分发 / Harness.prompt(text, images)
```

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
2. **按键**：底层保留实际键名和 Ctrl/Alt/Shift/Meta 等修饰键，不把 `Ctrl+Shift+C` 提前折叠成 `Ctrl+C`。普通 Enter 进入提交路径；CC 可识别的 Shift/Meta+Enter、反斜杠加 Enter 进入换行路径。建议、选择器等有焦点时先由相应上下文处理。
3. **粘贴**：带标记粘贴是单个事件，内容中的换行和 Tab 不触发提交或补全。参照 CC 的 `usePasteHandler`，明确粘贴、大于 800 字符的输入块、图片路径进入粘贴缓冲；100 ms 静默后合并处理。同步 pending 标志覆盖“粘贴与 Enter 同批到达”，避免用尚未提交的 UI 状态作判断。未标记的小块逐字粘贴存在终端协议无法消除的歧义，验收时如实记录。
4. **草稿**：短粘贴在光标处插入；超过 800 字符或显示行数限制的粘贴显示 `[Pasted text #N…]`，原文放在 `pastedContents`。图片显示 `[Image #N]`，与图片内容同属草稿状态。删除图片引用时移除附件；撤销和历史同时恢复文字、光标与引用数据。
5. **提交**：输入组件只提交草稿快照。REPL 接收后展开文本引用、只发送仍被引用的图片；单行斜杠命令走命令分发，普通输入走 `Harness.prompt`。粘贴占位符不能被原样发给模型。图片不能跨 `/new`、`/resume` 等命令残留到下一条消息。
6. **非 TTY**：管道输入到 EOF 作为一次完整输入处理；不把其中的换行当成 Enter。该行为保留为本项目 CLI 的明确接口，并单独验收。

## 分批施工顺序

每批开始前先说明对照的 CC 函数、拟改的本项目文件、预期行为；每批控制在少量函数和必要类型内。完成后给出差异与验证结果，停下供用户 review。下一批只在用户要求后开始。

| 批次 | 产物与 review 边界 | 主要源码对照 |
|---|---|---|
| 0（本次） | 归档旧五文件、断开 `main.ts`、确定本文；不实现新输入 | 旧 `src/cli/input/stash/` |
| 1 | 核对 React 与 CC 定制 Ink 的最小依赖；建立空宿主及唯一 stdin 所有者，接通 raw mode / bracketed paste 的启停与恢复 | Ink `App.tsx` |
| 2 | 终端 tokenizer 和按键事件：跨 chunk、UTF-8、修饰键、粘贴 `isPasted`；事件只从宿主发出 | `tokenize.ts`、`parse-keypress.ts`、`input-event.ts` |
| 3 | 聚焦分发和快捷键注册；先接提交、换行、中断，再逐组加入编辑快捷键 | `use-input.ts`、`src/keybindings/*` |
| 4 | 多行文本编辑：光标、删除、上下行、历史、普通 Enter 与换行键 | `useTextInput.ts`、`BaseTextInput.tsx` |
| 5 | 粘贴处理：明确粘贴、100 ms 合并、大块后备、图片剪贴板；检查同批 Enter | `usePasteHandler.ts`、`imagePaste.ts` |
| 6 | `PromptInput` 草稿状态：长文本占位符、图片引用、删除清理、撤销/历史快照和显示 | `PromptInput.tsx`、`useInputBuffer.ts` |
| 7 | REPL 边界：展开引用、附件筛选、斜杠命令、`Harness.prompt`、退出与终端恢复 | `history.ts`、`handlePromptSubmit.ts`、`REPL.tsx` |
| 8 | 端到端验收后恢复 `npm start`；更新 README、架构书和当前测试命令 | 完整输入链路 |

每批的测试只覆盖该层最容易出错的契约：跨 chunk、粘贴加 Enter、修饰键冲突、长文本还原、删除图片引用、历史恢复、非 TTY EOF。最终另做真实终端手测。旧 `stash` 代码和测试只用于对照，不进入新入口。

## 当前代码边界

- `src/cli/input/stash/`：历史快照，不作为新输入的实现起点。
- `src/cli/utils/image.ts`：现有剪贴板读取可在第 5 批评估是否适配 CC 的图片处理；在此之前不接回 `main.ts`。
- `src/harness/`、`src/agent/`、`src/llm/`：本次不改。它们只在第 7 批通过明确的提交结果接入。
- `src/cli/main.ts`：目前仅保留 Harness 装配并报告交互入口不可用。新输入完成前不提供临时 readline 或旧 `CliPrompt` 回退。
