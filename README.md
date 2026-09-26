# cli-agent

参考 `../pi` 逐步构建的个人 CLI agent，目标是可开源、可持续演进的产品级 agent。按小点实现和 review，框架可以先搭好，功能按自己的需求设计。当前 **v1.2** 已接通 `Harness`、线性 jsonl 会话、四个工具、图片输入、自动上下文压缩和手动 `/compact`（用量超过窗口 1/4 时可用）；终端输入已改为可复用的事件解析与多行草稿框架。思考等级与 BYOK 将作为同一项功能规划，具体方案待定，真实模型压缩验收暂缓。v1.3 计划做 TUI，并复用当前输入底层。当前设计见 [架构书](docs/architecture.md)，开发历史和待办见 [进度文档](docs/progress.md)。

换对话先看 **[docs/progress.md](docs/progress.md)**，再按 **[docs/architecture.md](docs/architecture.md)** 对照。

```
cd cli-agent
npm start
```

`.env` 里填 `OPENAI_API_KEY`。可选 `OPENAI_BASE_URL`、`OPENAI_MODEL`、`OPENAI_CONTEXT_WINDOW`。

交互输入支持直接粘贴多行文本：支持 bracketed paste 的终端会将整次粘贴插入草稿；Enter 发送，Ctrl+J 或终端能区分时的 Shift+Enter 插入换行。`/new`、`/resume`、`/context`、`/compact`、`/exit` 仍作为单行命令使用。图片仍可通过 Windows 的 Alt+V 或 macOS/Linux 的 Ctrl+V 从剪贴板加入当前消息。

对于不报告粘贴事件的终端，输入层会尝试识别快速连续的输入。无法可靠识别缓慢逐字转发的粘贴时，先输入 `/paste` 并按 Enter，粘贴完成后按 Ctrl+D 退出粘贴模式，检查草稿，再按 Enter 发送。Windows PowerShell、WebStorm 终端等实际组合的手动验收仍待完成；终端不提供 Shift+Enter 区分能力时，请用 Ctrl+J。
