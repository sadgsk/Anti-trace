# cli-agent

参考 `../pi` 逐步构建的个人 CLI agent，目标是可开源、可持续演进的产品级 agent。按小点实现和 review，框架可以先搭好，功能按自己的需求设计。当前 **v1.2** 已接通 `Harness`、jsonl 会话、四个工具及图片输入；上下文容量已有基础函数，完整接线和思考等级待完成。当前设计见 [架构书](docs/architecture.md)，开发历史和待办见 [进度文档](docs/progress.md)。

换对话先看 **[docs/progress.md](docs/progress.md)**，再按 **[docs/architecture.md](docs/architecture.md)** 对照。

```
cd cli-agent
npm start
```

`.env` 里填 `OPENAI_API_KEY`。可选 `OPENAI_BASE_URL`、`OPENAI_MODEL`、`OPENAI_CONTEXT_WINDOW`。
