# cli-agent

参考 `../pi` 逐步构建的个人 CLI agent，目标是可开源、可持续演进的产品级 agent。按小点实现和 review，框架可以先搭好，功能按自己的需求设计。当前 **v1.2** 已接通 `Harness`、线性 jsonl 会话、四个工具、图片输入、自动上下文压缩和手动 `/compact`（用量超过窗口 1/4 时可用）；思考等级与 BYOK 将作为同一项功能规划，具体方案待定，真实模型压缩验收暂缓。v1.3 计划做 TUI。当前设计见 [架构书](docs/architecture.md)，开发历史和待办见 [进度文档](docs/progress.md)。

换对话先看 **[docs/progress.md](docs/progress.md)**，再按 **[docs/architecture.md](docs/architecture.md)** 对照。

```
cd cli-agent
npm start
```

`.env` 里填 `OPENAI_API_KEY`。可选 `OPENAI_BASE_URL`、`OPENAI_MODEL`、`OPENAI_CONTEXT_WINDOW`。
