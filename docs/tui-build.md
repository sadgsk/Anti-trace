# TUI Build：参考 Claude Code 的终端界面实施方案（Design 生产 ⇄ 实现消费）

状态：**全部视觉组件的初版设计已按功能页并入产品原型 v0.1（`designcraft/2026-10-26_产品原型/`，21 个功能页），待整体 review 后统一修改；按用户要求先完成 `/` 命令菜单的后端与现有前端接线，已实现待 Review，后续由 DeepSeek 重设计相关界面；其余组件仍按看板推进**。更新：2026-10-29。

这份文档定义 `cli-agent`（Anti-trace）在 v1.3 阶段补齐完整 TUI 的功能范围、常用 React（Ink）组件库、前后端数据契约，以及**“Design 生产者 ⇄ `designcraft/` 资源池 ⇄ Implementation 消费者”**的异步协作流程。

**目录约定：** TUI 模块统一位于 `src/tui/`，作为 `src/` 的一级子目录，与 `harness/`、`agent/` 平行。当前命令菜单在 `src/tui/suggestions/`；本看板的后续 TUI 组件路径也遵循此约定。

---

## 1. 异步“生产者-消费者”协作模型与任务启动步骤

TUI 同时包含**视觉样式设计**与**前后端代码实现**。为了避免边写代码边改样式导致反复返工，也将每次对话的工作职责解耦，本阶段将 **Design（设计样式）** 与 **Implementation（编写代码）** 拆成两条通过 `designcraft/` 资源池与本文 §2 看板异步协同的流水线：

```text
┌───────────────────────────┐
│  §2 组件注册表（待设计池） │
└─────────────┬─────────────┘
              │ 挑选 [Design 状态 = 待设计] 的组件
              ▼
╔═══════════════════════════╗
║   Design 模式（生产者）    ║  ← 只设计视觉样式与各状态排版，不改 src/ 源码
╚═════════════╤═════════════╝
              │ 用户确认满意，产出设计资源包
              ▼
┌─────────────────────────────────────────────────────────┐
│  designcraft/<日期>_<组件名>/ （已定稿设计资源池 / 缓冲区）│
│  + 更新本文 §2 看板：Design 状态 = 已定稿，填入资源路径  │
└─────────────┬───────────────────────────────────────────┘
              │ 解锁信号：已有定稿 Design 资源（或属无需设计的纯底座）
              ▼
╔═══════════════════════════╗
║ Implementation（消费者）   ║  ← 读取 designcraft 资源 + claude-code-rev 源码
╚═════════════╤═════════════╝     按“说明主流程 → 前后端实现 → 验证 → Review”推进
              │
              ▼
┌───────────────────────────┐
│  更新 §2 看板：已完成      │
└───────────────────────────┘
```

- **解耦原则**：
  - 用户可以在任意时间开启 **Design 模式**（连续设计一个或多个组件，不断往 `designcraft/` 生产定稿资源），也可以在任意时间开启 **Implementation 模式**（从“已定稿但未实现”的组件队列中消费，带着用户一个点一个点写代码并 Review）。
  - **视觉组件未完成 Design 定稿前，消费者不得凭空猜测样式去写该组件的 JSX 代码**；但**无需视觉设计的纯后端／状态底座（`FD-*`）**以及**已有定稿资源的组件（如 `TH-01`、`LY-01`）**随时可以开始实现。

---

### 1.1 当用户开启【Design 任务（生产者模式）】时的启动步骤

每次用户要求“设计某个组件”或“看看还有哪些组件没被 Design”时，Agent 按以下 4 步执行：

1. **Step D1｜盘点看板与现有设计资产**：
   - 读取本文 **§2 组件状态总看板**，并扫描本地 `designcraft/` 目录，向用户汇报当前还有哪些组件处于 `待设计`、哪些已 `已定稿`，确认本次要设计的组件 ID（如 `DS-02`、`TL-01` 等）。
   - 读取 `designcraft/2026-09-21_anti-trace-TUI开机屏/tokens.css` 掌握全局基准色板与字体网格规范。
2. **Step D2｜对齐组件数据字段、全状态列表与 CC 参考**：
   - 查阅本文 **§6 对应组件的规格说明**与 `../claude-code-rev/src/` 对照源码，明确该组件需要承载的所有数据字段和全部视觉状态（默认态、聚焦/选中态、运行/流式态、折叠/展开态 `Ctrl+O`、空态、错误/中断态、窄屏折行态）。
3. **Step D3｜产出视觉设计方案并迭代至用户满意（期间不改 `src/` 代码）**：
   - 为该组件的各个状态设计具体的视觉样式（标注颜色 Token、前导符号 Glyph、边框线型、缩进列数、折行截断规则及底部快捷键提示）。
   - 根据用户反馈反复打磨，直到用户明确确认样式满意。
4. **Step D4｜落盘 `designcraft/` 资源并更新 §2 看板（生产入库）**：
   - 将定稿的设计产物（设计图、HTML/CSS 预览稿、`tokens.css` 补充或排版规范说明）保存到 `designcraft/<YYYY-MM-DD>_<组件标识与名称>/`。
   - 更新本文 **§2 组件状态总看板**：将该组件的 `Design 状态` 改为 **`已定稿`**，填上具体的 `designcraft/` 资源路径，若其前置代码依赖已满足则将 `实现状态` 更新为 **`就绪待实现`**。

---

### 1.2 当用户开启【Implementation 任务（消费者模式）】时的启动步骤

每次用户要求“开始实现 TUI 功能”或“看看现在有哪些已经 Design 好的组件可以实现”时，Agent 按以下 5 步执行：

1. **Step I1｜读进度并从 §2 看板筛选“可消费”条目**：
   - 先读 [progress.md](./progress.md) 的协作约定，再读本文 **§2 组件状态总看板**。
   - 向用户列出当前所有满足 **`Design 状态 = 已定稿（或无需设计）` 且 `前置依赖已满足` 且 `实现状态 != 已完成`** 的可施工条目，由用户指定（或按 §7 推荐顺序选定）本次要实现的一个小点。
2. **Step I2｜同时读取 `designcraft/` 设计资源与 `claude-code-rev` 源码**：
   - 如果是视觉组件，**必须先读取其绑定的 `designcraft/` 资源目录**（严格按定稿的色值、符号、间距和状态分支还原，不自行发挥样式）。
   - 同时阅读本文 §4、§6 指明的 `../claude-code-rev/src/` 对照文件，理清其状态管理、键盘动作与边界条件。
3. **Step I3｜动手前说明主流程函数／主组件**：
   - 写代码前先向用户说明本批新增或完善的主流程函数／主组件：它接收什么输入（Props / 事件 / 状态）、如何调用配套的后端数据或子组件、向外输出什么渲染结果或动作，以及相对 Claude Code 的取舍。
4. **Step I4｜按最终结构一次性实现前后端并统一验证**：
   - 写入本批代码（前后端数据接口与 React Ink 视图一步到位，不写临时过渡代码；若确有依赖尚未解锁的后续组件，在代码原处注明“阶段性”、原因与替换组件 ID）。
   - 整个功能点写完后，统一运行 `npm run typecheck`、`npm run build`、`git diff --check` 及对应本地行为验证，不在写到一半时插探针。
5. **Step I5｜更新 §2 看板状态并停下等待 Review**：
   - 交代改动文件、Design 还原情况、验证结果与未覆盖项。
   - 将本文 §2 看板中该条目的 `实现状态` 更新为 **`已实现待 Review`**（待用户 Review 通过后改为 **`已完成`**，并检查是否解锁了下游组件的依赖），同步 [progress.md](./progress.md)，**停下等待用户 Review**。未获明确指令前不自动进入下一批，也不执行 `git commit`。

---

## 2. TUI 组件与底座状态总看板（Producer-Consumer 队列）

> **2026-10-26 进展：** 全部视觉组件的初版设计已并入整体产品原型 `designcraft/2026-10-26_产品原型/`（21 个功能页 + 组件覆盖矩阵），按功能页整体 review；下表 Design 状态待整体确认后统一回填 `已定稿`。

> **2026-10-29 本批范围：** 用户指定先实现隐藏命令列表与 `/` 二级菜单，再重设计界面。本批完成 FD-05 的命令注册表、OV-01 的 `/` 命令菜单及已有输入焦点接线，沿用当前 Ink 组件完成可用交互；不将原型或菜单视觉标记为已定稿，`@` 文件补全、通用焦点栈及各命令专用弹窗仍未实现。

> **看板使用规则：**
> - **Design 生产者**看 `Design 状态` 列：挑选 `待设计` 的条目进行设计；定稿后写入 `designcraft/` 路径并将状态改为 `已定稿`。
> - **Implementation 消费者**看 `实现状态` 列：只消费 `就绪待实现`（即 `无需设计` 或 `已定稿`，且前置依赖已完成）的条目。

### 2.1 纯逻辑与后端数据底座（无需视觉 Design，可直接消费实现）

| ID | 模块名称 | 目标源码路径 | 前置依赖 | Design 状态 | 实现状态 |
|---|---|---|---|---|---|
| **FD-01** | **焦点栈与快捷键桥接**<br>(`FocusStackProvider`、`useInputTarget`、`useKeybinding`) | `src/tui/focus/focus-stack.tsx` | 已有 `InputDispatcher` | `无需设计` | **就绪待实现** |
| **FD-02** | **结构化消息流状态模型**<br>(`TranscriptItem`、活动回合投影、`Ctrl+O` 全局展开态) | `src/cli/repl/repl-controller.ts` | 已有 `Harness` 事件 | `无需设计` | **就绪待实现** |
| **FD-03** | **工具后端 `details` 与实时流增强**<br>(`edit` diff hunks、`write` 预览/hunks、`bash` `onUpdate` 实时流) | `src/harness/tools/{edit,write,bash,read}.ts` | 已有四个工具实现 | `无需设计` | **就绪待实现** |
| **FD-04** | **工具权限拦截内核与模式状态机**<br>(`beforeToolCall` 挂起/恢复、`default`/`auto-edit`/`yolo` 与会话白名单) | `src/tui/permissions/permission-policy.ts`<br>`src/harness/harness.ts` | 已有 `Agent.beforeToolCall` | `无需设计` | **就绪待实现** |
| **FD-05** | **输入补全数据源**<br>(`/` 斜杠命令注册表、`@` 工作区文件模糊搜索索引) | `src/cli/commands/command-registry.ts`<br>`src/tui/suggestions/suggestion-sources.ts` | 已有 `PromptDraft` | `无需设计` | **`/` 已实现待 Review；`@` 待实现** |

### 2.2 视觉与交互 React 组件看板（需先产出 `designcraft/` 资源再消费实现）

| ID | 组件分类与名称 | 目标源码路径 | 前置依赖 | Design 状态 | `designcraft/` 资源路径 | 实现状态 |
|---|---|---|---|---|---|---|
| **TH-01** | **主题色板、真彩降级与跨平台符号库**<br>(`ThemeProvider`, `ThemedText`, `ThemedBox`, `color.ts`, `figures.ts`) | `src/tui/theme/*` | 无 | **已定稿** | `designcraft/2026-09-21_anti-trace-TUI开机屏/tokens.css`<br>`02-艺术字规范@2x.png` | **就绪待实现** |
| **LY-01** | **Anti-trace 开机屏与艺术字 Logo**<br>(`WelcomeHeader`, `AsciiLogo`，含默认态、yolo 态与窄屏紧凑态) | `src/tui/layout/WelcomeHeader.tsx` | `TH-01` | **已定稿** | `designcraft/2026-09-21_anti-trace-TUI开机屏/01-anti-trace-开机屏@2x.png`<br>`01-anti-trace-开机屏-yolo@2x.png` | 等待前置 `TH-01`（Design 已就绪） |
| **DS-01** | **基础展示小原语**<br>(`Divider`, `Byline`, `KeyboardShortcutHint`, `StatusIcon`, `ProgressBar`) | `src/tui/design-system/{Divider,Byline,KeyboardShortcutHint,StatusIcon,ProgressBar}.tsx` | `TH-01` | **已定稿** | `designcraft/2026-10-26_DS-01_基础展示原语/`<br>(`design.html` + 场景样张) | 等待前置 `TH-01`（Design 已就绪） |
| **DS-02** | **通用面板、模态框与多标签页容器**<br>(`Pane`, `Dialog`, `Tabs`, `Tab`) | `src/tui/design-system/{Pane,Dialog,Tabs}.tsx` | `TH-01`, `FD-01`, `DS-01` | `待设计` | — | 等待 Design |
| **DS-03** | **通用单选与多选列表组件**<br>(`ListItem`, `Select` 含内联文本输入项, `MultiSelect`) | `src/tui/design-system/{ListItem,Select,MultiSelect}.tsx` | `TH-01`, `FD-01`, `DS-01` | `待设计` | — | 等待 Design |
| **DS-04** | **模糊搜索选择器**<br>(`FuzzyPicker`：搜索框 + 过滤列表 + 预览区) | `src/tui/design-system/FuzzyPicker.tsx` | `DS-02`, `DS-03` | `待设计` | — | 等待 Design |
| **LY-02** | **主屏幕布局骨架与底部状态栏**<br>(`ReplScreen`, `StatusLine`, `TokenWarning`) | `src/tui/layout/{ReplScreen,StatusLine}.tsx` | `TH-01`, `FD-01`, `FD-02`, `LY-01` | `待设计` | —（可基于开机屏状态栏扩展） | 等待 Design |
| **LY-03** | **动态 Spinner 加载行与流光计时组件**<br>(`SpinnerWithVerb`, `SpinnerAnimationRow`, `ShimmerText`) | `src/tui/layout/Spinner.tsx` | `TH-01`, `FD-02` | `待设计` | — | 等待 Design |
| **LY-04** | **增强输入框外框与附件徽标栏**<br>(`PromptInputBox`：`you>`/模式前缀、`[Image #N]`/`[Pasted #N]` 徽标条) | `src/tui/layout/PromptInputBox.tsx` | `TH-01`, `FD-01` | `待设计` | — | 等待 Design |
| **MSG-01** | **消息缩进容器与用户消息卡片**<br>(`MessageResponse` `⎿`, `UserPromptMessage`, `CtrlOToExpand`) | `src/tui/messages/{MessageResponse,UserPromptMessage,CtrlOToExpand}.tsx` | `TH-01`, `FD-02` | `待设计` | — | 等待 Design |
| **MSG-02** | **模型思考块组件**<br>(`AssistantThinkingMessage`：`∴ Thinking` 折叠态与 `▎` 展开态) | `src/tui/messages/AssistantThinkingMessage.tsx` | `MSG-01`, `MD-01` | `待设计` | — | 等待 Design |
| **MSG-03** | **上下文压缩边界与摘要展开卡片**<br>(`CompactBoundaryMessage`：`✻ Conversation compacted`) | `src/tui/messages/CompactBoundaryMessage.tsx` | `MSG-01` | `待设计` | — | 等待 Design |
| **MSG-04** | **系统通知、配置错误诊断卡片与中断提示**<br>(`SystemNoticeMessage`, `ErrorMessage`, `InterruptedByUser`) | `src/tui/messages/SystemNoticeMessage.tsx` | `MSG-01` | `待设计` | — | 等待 Design |
| **MD-01** | **Markdown 渲染器与助手正文卡片**<br>(`Markdown`, `AssistantTextMessage`, `FilePathLink`) | `src/tui/markdown/{Markdown,FilePathLink}.tsx`<br>`src/tui/messages/AssistantTextMessage.tsx` | `TH-01`, `FD-02` | `待设计` | — | 等待 Design |
| **MD-02** | **终端自适应表格与语法高亮代码块**<br>(`MarkdownTable`, `HighlightedCode`) | `src/tui/markdown/{MarkdownTable,HighlightedCode}.tsx` | `MD-01` | `待设计` | — | 等待 Design |
| **MD-03** | **结构化行级与词级 Diff 组件**<br>(`StructuredDiff`：行号 Gutter、增删底色、词级高亮) | `src/tui/diff/StructuredDiff.tsx` | `TH-01` | `待设计` | — | 等待 Design |
| **TL-01** | **工具调用通用外框与闪烁状态点**<br>(`ToolUseCard`, `ToolUseLoader`) | `src/tui/tools/{ToolUseCard,ToolUseLoader}.tsx` | `MSG-01`, `FD-02` | `待设计` | — | 等待 Design |
| **TL-02** | **Read 工具卡片与连续只读聚合折叠视图**<br>(`ReadToolView`, `GroupedToolUseView`) | `src/tui/tools/{ReadToolView,GroupedToolUseView}.tsx` | `TL-01`, `FD-03`, `MD-02` | `待设计` | — | 等待 Design |
| **TL-03** | **Edit 工具卡片（内嵌 Diff）**<br>(`EditToolView`) | `src/tui/tools/EditToolView.tsx` | `TL-01`, `FD-03`, `MD-03` | `待设计` | — | 等待 Design |
| **TL-04** | **Write 工具卡片（新建代码预览／覆写 Diff）**<br>(`WriteToolView`) | `src/tui/tools/WriteToolView.tsx` | `TL-01`, `FD-03`, `MD-02`, `MD-03` | `待设计` | — | 等待 Design |
| **TL-05** | **Bash 工具卡片与运行中实时输出流**<br>(`BashToolView`, `BashProgressView`) | `src/tui/tools/BashToolView.tsx` | `TL-01`, `FD-03` | `待设计` | — | 等待 Design |
| **OV-01** | **输入框 `/` 命令与 `@` 文件自动补全浮层**<br>(`PromptSuggestions`) | `src/tui/suggestions/PromptSuggestions.tsx`<br>`prompt-suggestions-controller.ts` | `/` 使用已有 `InputDispatcher` / `PromptInput`；完整外框仍依赖 `FD-01`, `FD-05`, `LY-04` | `待重设计` | 原型 P09/P10 初版，待本次交互调整后重设计 | **`/` 交互已实现待 Review；`@` 与视觉定稿待后续** |
| **OV-02** | **工具执行权限审批弹窗**<br>(`PermissionDialog`：内嵌 Diff/命令预览 + 三选一审批与内联拒绝反馈) | `src/tui/permissions/PermissionDialog.tsx` | `FD-04`, `DS-02`, `DS-03`, `MD-03` | `待设计` | — | 等待 Design |
| **OV-03** | **会话恢复选择器弹窗 (`/resume`)**<br>(`SessionPickerDialog`) | `src/tui/dialogs/SessionPickerDialog.tsx` | `DS-02`, `DS-03` (或 `DS-04`) | `待设计` | — | 等待 Design |
| **OV-04** | **模型切换选择器弹窗 (`/model`)**<br>(`ModelPickerDialog`) | `src/tui/dialogs/ModelPickerDialog.tsx` | `DS-02`, `DS-03` | `待设计` | — | 等待 Design |
| **OV-05** | **思考开关与五档强度选择器弹窗 (`/thinking`, `/effort`)**<br>(`ThinkingPickerDialog`) | `src/tui/dialogs/ThinkingPickerDialog.tsx` | `DS-02`, `DS-03` | `待设计` | — | 等待 Design |
| **OV-06** | **上下文容量可视化面板 (`/context`)**<br>(`ContextDialog`) | `src/tui/dialogs/ContextDialog.tsx` | `DS-01`, `DS-02` | `待设计` | — | 等待 Design |
| **OV-07** | **BYOK 配置诊断与重载面板 (`/config`, `/reload`)**<br>(`ConfigStatusDialog`) | `src/tui/dialogs/ConfigStatusDialog.tsx` | `DS-02` | `待设计` | — | 等待 Design |
| **OV-08** | **命令与快捷键多标签帮助弹窗 (`/help`, `?`)**<br>(`HelpDialog`) | `src/tui/dialogs/HelpDialog.tsx` | `DS-02` | `待设计` | — | 等待 Design |

---

## 3. 全局架构红线与视觉基准

无论是 Design 阶段还是 Implementation 阶段，都必须遵守以下 5 条不可破坏的约束：

1. **唯一 stdin 所有者与焦点栈路由（严禁使用 Ink 原生 `useInput`）**：
   - `src/cli/ink/terminal-host.ts` 独占真实 `process.stdin`，传给 Ink `render()` 的只是一个空 `PassThrough` 流。
   - **任何新组件（`Dialog`、`Select`、`Tabs`、`FuzzyPicker`、`PromptSuggestions`）都不得调用 Ink 的 `useInput`**，必须统一通过 `FD-01`（`FocusStackProvider` + `useInputTarget`）挂载到 `InputDispatcher`，按 `Modal / Permission` > `Suggestion` > `PromptInput` > `Global` 的焦点优先级消费按键。
2. **`<Static>` 历史固化 + 高频动画下沉叶子节点**：
   - 已完成的对话回合与开机屏放入 Ink `<Static>`，只向终端回滚缓冲区打印一次；只有正在生成的流式回合、正在运行的工具卡片、Spinner、弹窗和输入框留在动态渲染树中。
   - 50ms～80ms 的动画定时器（`SpinnerAnimationRow`、`ToolUseLoader` 闪烁点、`ShimmerText`）必须严格封在最底层叶子组件内部，禁止把高频 timer 放在顶层 `ReplScreen` 或 `ReplController` 触发整棵树重绘。
3. **赛博朋克 60/30/10 视觉基准（源自 `designcraft/.../tokens.css`）**：
   - 主色板：`--at-yellow` (`#FCEE0A`，主视觉/大字/光标/关键徽标)、`--at-cyan` (`#00F0FF`，命令/提示符 `you>`/装饰线/选中指针 `❯`)、`--at-red` (`#FF003C`，仅限错误/中断/拒绝/告警，常规状态禁用)、`--at-grey` (`#898D99`，次级文案)、`--at-dim` (`#393B42`，暗色/折叠态/未选中)、`--at-faint` (`#1E2025`，弱分割线/边框)。
   - 黄、青、红三色不要在同一个常规小组件内同时堆砌；保持深色背景下的高对比度与呼吸感。
4. **BYOK 配置错误可恢复约定（review No.5）**：
   - 无 `byok.json`、配置损坏或请求报错时，TUI 界面、开机屏、状态栏以及 `/new`、`/resume`（`OV-03`）、`/model`（`OV-04`）、`/config`（`OV-07`）、`/help`（`OV-08`）弹窗必须全部正常工作；仅在发起对话或压缩时内部拦截并以结构化卡片（`MSG-04`）提示修正入口。
5. **非 TTY 管道模式兼容**：
   - 当 `!stdin.isTTY || !stdout.isTTY` 时，不挂载交互式弹窗或 Spinner 动画；沿用 `runPipe()` 收集输入到 EOF 并输出纯文本结果。

---

## 4. Claude Code (`claude-code-rev`) 源码对照总表

本地参考仓库位于 `../claude-code-rev`（`e:\pi-harness\claude-code-rev`）。每次做 Design 或 Implementation 时，按组件 ID 查阅以下对照源码（借其组件结构、Props 与交互细节，不搬运其遥测、OAuth、多 Agent 组队及专有 Rust NAPI）：

| 本项目组件 ID | `claude-code-rev/src/` 对照文件 | 关键参考点 |
|---|---|---|
| **TH-01** | `utils/theme.ts`、`components/design-system/{ThemeProvider,ThemedText,ThemedBox,color}.tsx`、`constants/figures.ts` | 语义化颜色 Token 表、跨平台字符回退（macOS `⏺` vs Win/Linux `●`） |
| **FD-01** | `keybindings/useKeybinding.ts`、`ink/hooks/use-input.ts` | 上下文激活门控（`isActive`）与焦点拦截思路；本项目对接已有 `InputDispatcher` |
| **DS-01** | `components/design-system/{Divider,Byline,KeyboardShortcutHint,StatusIcon,ProgressBar}.tsx` | 内联中点连接 `Byline`、带标题分割线 `Divider`、字符进度条计算 |
| **DS-02** | `components/design-system/{Pane,Dialog,Tabs}.tsx` | `Pane` 顶部彩色边线；`Dialog` 的 `isCancelActive`（内嵌输入框时放行 Esc/Ctrl+C）与底部快捷键指南；`Tabs` 焦点切换 |
| **DS-03** | `components/design-system/ListItem.tsx`、`components/CustomSelect/{select,SelectMulti,select-input-option,use-select-state,use-select-navigation}.tsx` | 视窗滚动、数字键 `1..9` 直选、禁用项、以及 `type: 'input'` 的内联可打字选项 |
| **DS-04** | `components/design-system/FuzzyPicker.tsx` | 搜索框 + 过滤列表 + 预览窗布局与键盘联动 |
| **LY-01** | `components/LogoV2/{WelcomeV2,LogoV2,CondensedLogo}.tsx` + 本地 `designcraft/2026-09-21_anti-trace-TUI开机屏/` | 宽屏完整艺术字与窄屏（`< 80` 列）紧凑头部的自适应切换 |
| **LY-02** | `screens/REPL.tsx`、`components/StatusLine.tsx`、`components/TokenWarning.tsx`、`components/PromptInput/PromptInputFooter.tsx` | `<Static>` 与动态区域划分、底部状态栏信息排布、上下文容量接近上限时的预警提示 |
| **LY-03** | `components/Spinner.tsx`、`components/Spinner/{SpinnerAnimationRow,SpinnerGlyph,ShimmerChar,useShimmerAnimation,useStalledAnimation}.tsx` | 帧定时器隔离在 `SpinnerAnimationRow`、流光字符着色、思考最少显示 2s、流卡顿变色提醒 |
| **LY-04 / OV-01** | `components/PromptInput/{PromptInput,PromptInputFooterSuggestions,PromptInputModeIndicator}.tsx` | 输入框外围模式指示、附件徽标、下方最多 5 项的 `/` 与 `@` 补全浮层 |
| **MSG-01..04** | `components/{Messages,MessageRow,MessageResponse,CtrlOToExpand,InterruptedByUser}.tsx`、`components/messages/{UserPromptMessage,AssistantThinkingMessage,CompactBoundaryMessage,SystemAPIErrorMessage}.tsx` | `MessageResponse` 的 `  ⎿  ` 防嵌套缩进、用户超长文本首尾截断、`∴ Thinking` 折叠与展开、`✻ Conversation compacted` |
| **MD-01..02** | `components/{Markdown,MarkdownTable,HighlightedCode,FilePathLink}.tsx`、`utils/markdown.ts` | `marked` 词法缓存 + 纯文本快速跳过、终端列宽自适应表格、代码块语法高亮 |
| **MD-03** | `components/StructuredDiff.tsx`、`components/StructuredDiff/Fallback.tsx`、`components/FileEditToolDiff.tsx` | 行号 Gutter 宽度计算、相邻增删行配对、`diffWordsWithSpace` 词级高亮（阈值 `0.4`） |
| **TL-01..05** | `components/ToolUseLoader.tsx`、`components/messages/{AssistantToolUseMessage,GroupedToolUseContent}.tsx`、`tools/{FileReadTool,FileEditTool,FileWriteTool,BashTool}/UI.tsx` | 状态点闪烁与 ANSI 样式隔离、各工具头部与 `⎿` 结果区排版、连续 Read 折叠、`bash` 实时输出进度 |
| **OV-02** | `components/permissions/{PermissionDialog,PermissionRequest}.tsx`、`FilePermissionDialog/FilePermissionDialog.tsx`、`BashPermissionRequest/BashPermissionRequest.tsx` | 执行前 Diff/命令预览、三选一审批（允许本次 / 会话记住 / 拒绝并内联输入指导意见） |
| **OV-03..08** | `components/{ModelPicker,LogSelector,ContextVisualization,ThemePicker}.tsx`、`components/HelpV2/HelpV2.tsx` | `/resume`、`/model`、`/thinking`、`/context`、`/config`、`/help` 的交互式选择器与面板布局 |

---

## 5. 从当前代码开始的改造点与前后端职责分层

### 5.1 现有模块保留与改造边界

| 现有路径 | 处理方式 |
|---|---|
| `src/cli/ink/{terminal-host,terminal-input}.ts` | **原样保留**。继续作为唯一 stdin 读取者与终端事件解析器 |
| `src/cli/input/*` | **原样保留编辑与粘贴核心**。在其上通过 `FD-01` 挂载焦点栈，通过 `LY-04` / `OV-01` 增加外框、附件徽标与补全浮层 |
| `src/cli/repl/repl-controller.ts` | **重点升级（`FD-02`）**。将扁平 `entries: { id, text, kind }[]` 升级为结构化 `TranscriptItem[]` + `activeTurn` + `activeDialog` + `pendingPermission` |
| `src/cli/repl/terminal-repl.tsx` | **重点升级（`LY-02`）**。将简单的 `ReplView` 替换为包裹在 `ThemeProvider` 与 `FocusStackProvider` 下的 `<ReplScreen />` |
| `src/cli/render.ts` | 保留 `previewToolResult` / `renderEvent` 仅供非 TTY 或最小兜底使用；交互式 TUI 改走 `src/tui/tools/*` 结构化渲染 |
| `src/harness/tools/{edit,write,bash,read}.ts` | **扩充 `details` 与 `onUpdate`（`FD-03`）**。不改变发给模型的 `content` 文本，仅丰富返回给 UI 的 `details` 结构化数据与实时进度回调 |
| `src/harness/harness.ts` | **接入权限回调与压缩通知（`FD-04`）**。将 `Agent.beforeToolCall` 暴露为可配置的异步权限检查钩子 |

---

## 6. 全部组件详细规格书（Design 生产者清单 & Implementation 消费者契约）

本节按 §2 看板中的组件 ID 逐项列出规格。**开启 Design 模式时，按“Design 产出要求”设计视觉稿；开启 Implementation 模式时，按“数据契约与实现要点”编写代码。**

---

### 6.1 纯逻辑与后端数据底座（`FD-01` ~ `FD-05`）

#### `FD-01`｜焦点栈与快捷键桥接（`src/tui/focus/focus-stack.tsx`）
- **功能与数据契约**：
  - 定义焦点层级枚举：`type FocusLayer = "modal" | "suggestion" | "editor" | "global"`。
  - 提供 `<FocusStackProvider dispatcher={dispatcher} baseBindings={...}>` 与 Hook `useInputTarget(layer, context, actions, isActive)`。
  - 每当有组件注册、更新或卸载 active target 时，按 `modal → suggestion → editor → global` 顺序重排 `InputTarget[]` 并同步调用 `dispatcher.configure(targets, bindings)`。
- **实现要点**：确保 `modal` 层激活时（如打开了 `Dialog` 或 `PermissionDialog`），底层的 `PromptInput` 不会收到字符输入或回车事件；模态框关闭后焦点无缝回到 `PromptInput`。

#### `FD-02`｜结构化消息流状态模型（`src/cli/repl/repl-controller.ts`）
- **功能与数据契约**：
  - 将 `ReplSnapshot` 中的历史记录与流状态升级为强类型结构：
    - `UserTurnItem`: `{ id, kind: "user", text, attachments: { type: "image" | "paste", label: string }[], timestamp }`
    - `AssistantTurnItem`: `{ id, kind: "assistant", blocks: (ThinkingBlockItem | TextBlockItem | ToolUseBlockItem)[], model?: string, usage?: ..., stopReason?: StopReason, errorMessage?: string, isStreaming: boolean }`
    - `ToolUseBlockItem`: `{ type: "tool", toolCallId: string, toolName: string, args: Record<string, unknown>, status: "queued" | "awaiting_permission" | "running" | "success" | "error" | "aborted" | "rejected", liveOutput?: string, result?: AgentToolResult, durationMs?: number }`
    - `CompactionItem`: `{ id, kind: "compaction", summary?: string, tokensBefore?: number, tokensAfter?: number, timestamp }`
    - `SystemNoticeItem`: `{ id, kind: "notice", level: "info" | "warning" | "error" | "interrupted", title?: string, message: string }`
  - 新增 `isTranscriptExpanded: boolean`（由全局快捷键 `Ctrl+O` 切换）与 `activeDialog: ActiveDialogState | null`。
- **实现要点**：已结束的回合自动移入 `staticItems`（供 `<Static>` 渲染），正在进行的回合留在 `activeTurn`；`/resume` 恢复会话时，将 JSONL 中的历史 `AgentMessage[]`（含关联的 `toolCall` 与 `toolResult`）还原为结构化 `TranscriptItem[]`。

#### `FD-03`｜工具后端 `details` 与实时流增强（`src/harness/tools/*.ts`）
- **功能与数据契约**：
  - **`edit.ts` (`EditToolDetails`)**：增加 `hunks: StructuredDiffHunk[]`、`addedLines: number`、`removedLines: number`。每个 hunk 包含 `{ oldStart, oldLines, newStart, newLines, lines: string[] }`（行前缀为 `+`/`-`/` `）。
  - **`write.ts` (`WriteToolDetails`)**：增加 `created: boolean`（区分新建文件与覆写已有文件）、`lineCount: number`、`previewLines?: string[]`（新建文件时保留前 10～20 行）、`hunks?: StructuredDiffHunk[]`（覆写已有文件时计算差异）。
  - **`bash.ts` (`BashToolDetails` & `onUpdate`)**：在子进程 stdout/stderr 到达时，调用 `onUpdate({ content: [...], details: { liveLines: string[], totalLines: number, elapsedMs: number } })`（做 80ms 节流，防止高频阻塞）；执行结束时在 `details` 中记录 `exitCode`、`timedOut`、`durationMs`、`totalLines`。
- **实现要点**：严格保持各工具返回给模型的 `content: [{ type: "text", text: ... }]` 格式不变，所有新增字段仅放入 `details`，不污染 LLM 上下文与前缀缓存。

#### `FD-04`｜工具权限拦截内核与模式状态机（`src/tui/permissions/permission-policy.ts`）
- **功能与数据契约**：
  - 权限模式：`type PermissionMode = "default" | "auto-edit" | "yolo"`，支持 `Shift+Tab` 循环切换。
  - 会话级白名单：记录用户在当前会话中选择“本会话不再询问”的规则（如允许本会话所有文件编辑，或允许特定前缀的 bash 命令）。
  - 对接 `Agent.beforeToolCall`：当工具需要审批时，在 `ReplController` 中生成一条挂起的 `PendingPermissionRequest`（含工具名、参数、预计算的预览 Diff/命令，以及 `resolve(decision)` 回调）：
    - 允许本次：`resolve(undefined)` 继续执行。
    - 允许并记住本会话：写入白名单后 `resolve(undefined)`。
    - 拒绝并附带反馈：`resolve({ block: true, reason: userFeedback || "User rejected this tool call." })`。
- **实现要点**：非 TTY 管道模式默认不弹交互框；正在等待权限审批时若用户按 `Ctrl+C` 中断，自动 reject/abort 并清理挂起状态。

#### `FD-05`｜输入补全数据源（`src/tui/suggestions/suggestion-sources.ts`）
- **功能与数据契约**：
  - 斜杠命令表（已实现待 Review）：`src/cli/commands/command-registry.ts` 统一定义所有斜杠命令的名称、参数提示、中文简述、必填参数及精确匹配规则（`/help`, `/new`, `/resume`, `/model`, `/thinking`, `/effort`, `/thinking-display`, `/context`, `/compact`, `/config`, `/reload`, `/exit`）。REPL 识别、帮助输出和菜单共用这份表；各命令专用弹窗仍未实现。
  - `@` 文件索引：异步扫描并缓存 `cwd` 下的相对文件路径（排除 `.git`、`node_modules`、`dist`），支持按子串或首字母模糊打分排序，返回前 N 条候选。

**已接通的 `/` 菜单契约（2026-10-29）：** `commandSuggestionQuery()` 从无附件的单行草稿读取行首命令前缀，要求光标在末尾；`getCommandSuggestions()` 返回匹配命令，完整名称优先。`PromptSuggestionsController` 订阅完整草稿及 REPL 状态，输出 `{ open, items, selectedIndex }` 和 `Suggestions` 输入 target。↑↓ 循环选择；Enter 确认无参操作，`/model` 补入参数编辑；Tab 仅补全命令，支持参数时追加空格；Esc 收起并保留草稿。`PromptSuggestions` 在输入框下方显示最多 6 项并随选中项滚动，小窗口减少行数，空结果显示提示。粘贴未完成、请求忙碌和会话序号输入期间禁用菜单；普通编辑、撤销重做、全局中断和非 TTY 命令沿用原有链路。原型 P09 需按此行为重设计；P10 的 `@` 补全不在本批。

---

### 6.2 主题与通用设计系统组件（`TH-01`、`DS-01` ~ `DS-04`）

#### `TH-01`｜主题色板、真彩降级与跨平台符号库（**Design 已定稿**）
- **Design 资源**：`designcraft/2026-09-21_anti-trace-TUI开机屏/tokens.css` 与 `02-艺术字规范@2x.png`。
- **包含文件**：`src/tui/theme/{theme.ts,color.ts,figures.ts,ThemeProvider.tsx}`。
- **实现要点**：
  - 精确收录 `tokens.css` 中的色值：`brand` (`#FCEE0A`)、`accent` (`#00F0FF`)、`error` (`#FF003C`)、`bg` (`#030408`)、`bgBar` (`#05070D`)、`muted` (`#898D99`)、`dim` (`#393B42`)、`faint` (`#1E2025`)，并补齐 `success`、`warning`、`permission`、`diffAdded`、`diffRemoved`、`diffAddedWord`、`diffRemovedWord`。
  - 实现 24-bit Truecolor 到 256 色（`226` 黄、`51` 青、`197` 红）的终端能力检测与转换函数。
  - 实现 `figures.ts` 符号常量与 `█`（U+2588）字宽检测辅助。

#### `DS-01`｜基础展示小原语（`Divider`, `Byline`, `KeyboardShortcutHint`, `StatusIcon`, `ProgressBar`）
- **数据输入 / Props**：
  - `Divider`: `{ width?: number; color?: ThemeColorKey; char?: "─" | "━" | "▔"; title?: string; padding?: number }`
  - `Byline`: `{ children: ReactNode }`（自动过滤空节点并用 ` · ` 连接）
  - `KeyboardShortcutHint`: `{ shortcut: string; action: string; parens?: boolean; bold?: boolean }`
  - `StatusIcon`: `{ status: "success" | "error" | "warning" | "info" | "pending" | "loading"; withSpace?: boolean }`
  - `ProgressBar`: `{ ratio: number; width: number; fillColor?: ThemeColorKey; emptyColor?: ThemeColorKey }`
- **Design 阶段需敲定的样式**：
  - 带标题与不带标题分割线的字符粗细与颜色（`--at-faint` vs `--at-cyan` / `--at-yellow`）。
  - 快捷键提示中“键名”与“动作描述”的明暗对比度（如键名亮色/青色、动作名 `--at-grey`/`--at-dim`）。
  - 6 种 `StatusIcon` 的符号与色值，以及 `ProgressBar` 的填充/空白字符与告警变色规则。

#### `DS-02`｜通用面板、模态框与多标签页容器（`Pane`, `Dialog`, `Tabs`）
- **数据输入 / Props**：
  - `Pane`: `{ color?: ThemeColorKey; children: ReactNode }`
  - `Dialog`: `{ title: ReactNode; subtitle?: ReactNode; color?: ThemeColorKey; onCancel: () => void; isCancelActive?: boolean; inputGuide?: ReactNode; hideBorder?: boolean; children: ReactNode }`
  - `Tabs` / `Tab`: `{ title?: string; selectedTab?: string; onTabChange?: (id: string) => void; children: ReactElement<TabProps>[] }`
- **Design 阶段需敲定的样式**：
  - 底部弹窗 `Pane` / `Dialog` 的顶部边线样式（单色实线或像开机屏一样的黄+青分段装饰线）、内边距、标题/副标题字重与颜色、底部 `Enter 确认 · Esc 取消` 指南行排版。
  - `Tabs` 标签栏的未选中态、聚焦选中态（下划线/反色/方括号高亮）与切换提示（`←/→ or Tab`）。

#### `DS-03`｜通用单选与多选列表组件（`ListItem`, `Select`, `MultiSelect`）
- **数据输入 / Props**：
  - `OptionWithDescription<T>`: 普通项 `{ label, value, description?, disabled? }` 或内联输入项 `{ type: "input", label, value, placeholder?, initialValue?, onChange }`。
  - `Select<T>`: `{ options, defaultValue?, visibleOptionCount?, onChange, onCancel?, hideIndexes?, layout?: "compact" | "expanded" }`。
- **Design 阶段需敲定的样式**：
  - 列表项在 **未聚焦未选中**、**当前键盘聚焦 (`❯`)**、**已生效选中 (`✓`)**、**禁用 (`disabled`)**、**内联打字输入态 (`type: 'input'`)** 五种状态下的前导符、序号（`1.`）、主标签、右侧副描述的配色与间距，以及超出 `visibleOptionCount` 时的上下滚动提示（`↑ N more` / `↓ N more`）。

#### `DS-04`｜模糊搜索选择器（`FuzzyPicker`）
- **数据输入 / Props**：`{ title, placeholder?, items, getKey, filterItem, renderItem, renderPreview?, onSelect, onCancel }`。
- **Design 阶段需敲定的样式**：顶部搜索输入框（放大镜或 `>` 提示符 + 匹配计数 `3/18`）、中部过滤列表、底部或右侧详情预览窗的分割线与空搜索结果态样式。

---

### 6.3 主界面骨架、开机屏、Spinner 与输入外框（`LY-01` ~ `LY-04`）

#### `LY-01`｜Anti-trace 开机屏与艺术字 Logo（**Design 已定稿**）
- **Design 资源**：`designcraft/2026-09-21_anti-trace-TUI开机屏/` 下的 `01-anti-trace-开机屏@2x.png`、`01-anti-trace-开机屏-yolo@2x.png`、`02-艺术字规范@2x.png`、`tokens.css`。
- **数据输入 / Props**：`{ cwd, sessionTitle, messageCount, modelName, thinkingStatus, contextUsed, contextWindow, permissionMode, terminalColumns }`。
- **实现要点**：
  - 按 `02-艺术字规范@2x.png` 精确拼出 6 行高、每字母 8 列、字距 4 列（`ANTI` 与 `TRACE` 间 3 列）的黄色 `█` 大字，中间斜画 `I` 为 4 列宽、每行右移 1 列的青色（`#00F0FF`）块。
  - 下方绘制黄+青双段横线、`local-first agent runtime` 青色副标题、次级灰标语（默认态 `会话只落本地磁盘 · 无遥测 · 无回传` / yolo 态 `yolo`）、左右对齐的环境与模型/思考/容量信息行，以及青色高亮的三个快捷命令提示（`/help 命令列表   /thinking 思考等级   /resume 接上次会话`）。
  - 窄终端（列宽不足以容纳完整 6 行艺术字）时自动降级为单行紧凑型 `ANT\TRACE` 头部。

#### `LY-02`｜主屏幕布局骨架与底部状态栏（`ReplScreen`, `StatusLine`, `TokenWarning`）
- **数据输入 / Props**：绑定 `ReplController` 快照、`PromptInputController` 与 `FocusStack`。
- **Design 阶段需敲定的样式**：
  - 对话开始后底部常驻 `StatusLine` 的左右信息排布（左侧：当前权限模式徽标 `default` / `auto-edit` / `yolo` 与 `Shift+Tab` 提示或快捷键提示；右侧：模型名、思考档位图标与状态、`ctx used / window`）。
  - `TokenWarning` 在上下文使用率达到 75% / 90% / 即将触发自动压缩时的颜色与文案样式。

#### `LY-03`｜动态 Spinner 加载行与流光计时组件（`SpinnerWithVerb`）
- **数据输入 / Props**：`{ phase: "thinking" | "streaming" | "tool" | "compacting", startTimeMs, lastEventTimeMs, outputTokensOrChars, activeToolName? }`。
- **Design 阶段需敲定的样式**：
  - 四个阶段（思考中、生成回复中、工具执行中、压缩上下文中）各自的旋转帧字符、动词文案、Shimmer 流光扫过效果、右侧 `(8s · ↓ 420 tokens · ctrl+c to interrupt)` 的排版，以及流响应卡顿超过 5 秒时的 Stalled 告警色与思考结束后的 `Thought for Ns` 简短留存样式。

#### `LY-04`｜增强输入框外框与附件徽标栏（`PromptInputBox`）
- **数据输入 / Props**：封装现有 `<PromptInput controller={prompt} />`，读取草稿中的图片/长文本粘贴引用列表、粘贴进行中状态与当前权限模式。
- **Design 阶段需敲定的样式**：
  - 输入框提示符 `you>`（青色 `#00F0FF`）与黄色块状光标 `█`（`#FCEE0A`）在不同权限模式（特别是 `yolo` 模式）下的视觉变化；多行输入时的左边缘对齐；当草稿中含有 `[Image #1]` 或 `[Pasted text #1]` 时的顶部附件徽标条（Pills）与 `Processing paste…` 提示样式。

---

### 6.4 结构化消息流、Markdown、代码与 Diff 组件（`MSG-01` ~ `MSG-04`、`MD-01` ~ `MD-03`）

#### `MSG-01`｜消息缩进容器与用户消息卡片（`MessageResponse`, `UserPromptMessage`, `CtrlOToExpand`）
- **Design 阶段需敲定的样式**：
  - 用户已发送消息在历史流中的样式（前导符 `you>` 或背景色条、与上下文消息的行间距、消息内 `[Image #1]` 标签的高亮色、超长输入被截断时的 `… +N lines …` 提示行样式）。
  - `MessageResponse` 子结果容器的前导符号（`  ⎿  `）颜色与缩进列数，以及 `(ctrl+o to expand)` 提示标签样式。

#### `MSG-02`｜模型思考块组件（`AssistantThinkingMessage`）
- **Design 阶段需敲定的样式**：
  - **折叠态**（`/thinking-display off` 且未按 `Ctrl+O`）：单行 `∴ Thinking (ctrl+o to expand)` 或带思考耗时 `∴ Thought for 6s (ctrl+o to expand)` 的暗色斜体样式。
  - **展开态**（`/thinking-display on` 或按 `Ctrl+O`）：标题行 + 左侧竖线 `▎` 缩进的暗色思考正文排版。

#### `MSG-03`｜上下文压缩边界与摘要展开卡片（`CompactBoundaryMessage`）
- **Design 阶段需敲定的样式**：
  - 自动压缩或手动 `/compact` 完成时的分割线与 `✻ Conversation compacted · 98k → 14k tokens (ctrl+o for summary)` 提示样式，以及按 `Ctrl+O` 展开后的摘要正文卡片样式。

#### `MSG-04`｜系统通知、配置错误诊断卡片与中断提示（`SystemNoticeMessage`, `InterruptedByUser`）
- **Design 阶段需敲定的样式**：
  - 普通命令反馈（如切换模型、新建会话）、警告提示、BYOK 配置错误/请求失败的可恢复诊断卡片（醒目指出错误原因与 `/config`、`/model` 修复命令），以及用户按 `Ctrl+C` 中断后的 `⎿  Interrupted · What should Anti-trace do instead?` 样式。

#### `MD-01` & `MD-02`｜Markdown 渲染器、自适应表格与语法高亮代码块（`Markdown`, `MarkdownTable`, `HighlightedCode`, `FilePathLink`）
- **Design 阶段需敲定的样式**：
  - 助手回复顶层圆点（`⏺`/`●`）颜色；Markdown 一至三级标题、粗体、斜体、行内代码（`` `code` ``）、引用块（`▎`）、有序/无序列表的项目符号与色值。
  - 代码块（`HighlightedCode`）的顶部语言标识栏、边框/背景、语法高亮配色方案（适配赛博朋克深色底）与行号样式。
  - 终端表格（`MarkdownTable`）的边框字符（`┌─┬─┐` / `├─┼─┤`）、表头高亮色与窄屏单元格折行规则。

#### `MD-03`｜结构化行级与词级 Diff 组件（`StructuredDiff`）
- **Design 阶段需敲定的样式**：
  - 行号 Gutter 的宽度、颜色与分隔符；新增行（`+`）与删除行（`-`）的整行浅底色（`diffAdded` / `diffRemoved`）以及行内具体修改词汇的深色/高亮背景（`diffAddedWord` / `diffRemovedWord`）；多个 Hunk 之间的省略分隔行（`⋯`）样式。

---

### 6.5 工具调用与结果专属卡片（`TL-01` ~ `TL-05`）

#### `TL-01`｜工具调用通用外框与闪烁状态点（`ToolUseCard`, `ToolUseLoader`）
- **Design 阶段需敲定的样式**：
  - 工具卡片顶行：`[状态点] [工具动作名] ([目标路径或命令]) [耗时/附属标签]` 的颜色搭配；状态点在“等待权限”、“执行中闪烁”、“成功”、“失败/拒绝”四种状态下的颜色与符号。

#### `TL-02`｜Read 工具卡片与连续只读聚合折叠视图（`ReadToolView`, `GroupedToolUseView`）
- **Design 阶段需敲定的样式**：
  - 单次 `read`：`⏺ Read(src/cli/main.ts · lines 1-80)` 与下方 `⎿  Read 80 lines (ctrl+o to expand)`（及图片读取 `⎿  Read image (52 KB)`）的样式；展开态下的代码预览高度与样式。
  - 连续多次 `read` 聚合折叠：`⏺ Read 4 files (ctrl+o to expand)` 的紧凑汇总样式。

#### `TL-03` & `TL-04`｜Edit 与 Write 工具卡片（`EditToolView`, `WriteToolView`）
- **Design 阶段需敲定的样式**：
  - `EditToolView`：`⏺ Update(src/cli/repl/repl-controller.ts)` + `⎿  Updated ... with +12 / -4 lines` + 下方内嵌 `<StructuredDiff />` 的缩进与间距。
  - `WriteToolView`：新建文件 `⏺ Create(path)` + `⎿  Wrote N lines` + 前 10 行 `<HighlightedCode />` 预览与折叠提示；覆写文件 `⏺ Write(path)` + `<StructuredDiff />`。

#### `TL-05`｜Bash 工具卡片与运行中实时输出流（`BashToolView`, `BashProgressView`）
- **Design 阶段需敲定的样式**：
  - `⏺ Bash(command)` 命令头部的截断规则；运行中 `BashProgressView` 在 `⎿` 下方实时滚动显示最近 5 行输出与计时器的样式；执行结束后的输出折叠摘要（`… +N lines (ctrl+o to expand)`）、空输出 `(No content)` 以及非零退出码 / 超时的红色报错样式。

---

### 6.6 输入补全浮层、权限审批与六大交互弹窗（`OV-01` ~ `OV-08`）

#### `OV-01`｜输入框 `/` 命令与 `@` 文件自动补全浮层（`PromptSuggestions`）
- **Design 阶段需敲定的样式**：
  - 浮层在输入框下方的挂载位置、最大显示条数（如 5～6 条）、左侧命令名（青色 `/model`）或文件图标（`+ src/...`）与右侧灰字说明的列对齐方式、当前选中行的指示符与高亮色。

#### `OV-02`｜工具执行权限审批弹窗（`PermissionDialog`）
- **Design 阶段需敲定的样式**：
  - 审批框的醒目顶部边线与标题（如 `Allow Anti-trace to edit src/...?` 或 `Allow bash command?`）、中部内嵌的 `<StructuredDiff />` 或命令预览区最大高度、底部三个选项（`1. Yes` / `2. Yes, allow ... for this session` / `3. No, tell Anti-trace what to do differently` 选中后直接内联打字输入反馈）的交互样式。

#### `OV-03` ~ `OV-08`｜六个核心斜杠命令交互弹窗
- **各弹窗 Design 阶段需敲定的样式**：
  - **`OV-03` `SessionPickerDialog` (`/resume`)**：会话列表项（序号、10 字标题、相对/格式化修改时间、消息数）与底部选中会话的首末句预览框样式；空会话列表提示。
  - **`OV-04` `ModelPickerDialog` (`/model`)**：模型列表项（模型键 `main`、模型 ID、协议徽标 `chat`/`responses`/`anthropic`、上下文窗口 `128k`、当前生效勾 `✓`）及未加载有效配置时的引导提示。
  - **`OV-05` `ThinkingPickerDialog` (`/thinking`, `/effort`)**：思考开关（`on` / `off` / `default`）与五档强度（`low` ○ / `medium` ◐ / `high` ● / `xhigh` ◉ / `max` ✦）的切换布局与说明文案。
  - **`OV-06` `ContextDialog` (`/context`)**：上下文容量 `<ProgressBar />`、已用/总窗口百分比、自动压缩阈值刻度、手动 `/compact` 触发提示与窗口大小修改入口。
  - **`OV-07` `ConfigStatusDialog` (`/config`, `/reload`)**：配置文件路径、当前生效连接与模型详情、错误/警告高亮诊断块，以及按 `r` 重载的状态反馈。
  - **`OV-08` `HelpDialog` (`/help`, `?`)**：基于 `<Tabs>` 的“斜杠命令”、“输入与编辑快捷键”、“全局控制”分栏速查面板样式。

---

## 7. 实现消费者（Implementation）的推荐消费顺序

由于 Design 是异步生产的，实现消费者在挑选任务时遵循以下两条规则：

1. **已就绪即可消费**：只要某个组件在 §2 看板中的 `Design 状态` 为 **`已定稿`**（或 **`无需设计`**），且其 `前置依赖` 已经完成，就可以作为独立小批开始实现并交给用户 Review。
2. **推荐推进主线（当多个组件均已 Design 就绪时）**：
   - **第一梯队（立即可做，已具备 Design 或无需 Design）**：
     - `TH-01`（主题色板与符号库，已有 `tokens.css`） + `FD-01`（`FocusStack` 焦点栈）
     - `LY-01`（Anti-trace 开机屏，已有开机屏设计稿）
     - `FD-02`（结构化 `TranscriptItem` 状态模型） + `FD-03`（工具 `details` diff/流式输出后端增强） + `FD-04`（权限拦截内核） + `FD-05`（补全数据源）
   - **第二梯队（通用设计系统原语 Design 定稿后）**：
     - `DS-01`（基础小原语） → `DS-02`（`Pane` / `Dialog` / `Tabs`） → `DS-03` / `DS-04`（`Select` / `FuzzyPicker`）
   - **第三梯队（主屏、消息流、Markdown、Diff 与工具卡片 Design 定稿后）**：
     - `LY-02`（主屏幕骨架与 `StatusLine`） + `LY-03`（`SpinnerWithVerb`） + `LY-04`（`PromptInputBox`）
     - `MSG-01..04`（消息卡片与压缩/通知/思考） + `MD-01..03`（Markdown、表格、代码高亮与 `StructuredDiff`）
     - `TL-01..05`（四大工具专属卡片与连续只读折叠）
   - **第四梯队（浮层、权限弹窗与命令选择器 Design 定稿后）**：
     - `OV-01`（`/` 与 `@` 自动补全浮层）
     - `OV-02`（`PermissionDialog` 工具权限审批弹窗与 `Shift+Tab` 模式切换）
     - `OV-03..08`（`/resume`, `/model`, `/thinking`, `/context`, `/config`, `/help` 六大交互弹窗）
   - **收尾验收**：全部组件消费完毕后，执行整条 TUI 端到端验收与非 TTY 管道回归。
