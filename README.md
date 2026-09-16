# cli-agent

平行于 `../pi` 的学习用 CLI agent。能对话，能 `read` / `write` / `edit` / `bash`。当前 **v1.2**：`Harness` 框架已搭（装配在管家里，`main` 不再 `createXxxTool` / `new Agent`）。下一步 jsonl 记忆，然后上下文容量、思考等级。

换对话先看 **[docs/progress.md](docs/progress.md)**，再按 **[docs/architecture.md](docs/architecture.md)** 对照。

```
cd cli-agent
npm start
```

`.env` 里填 `OPENAI_API_KEY`。可选 `OPENAI_BASE_URL`、`OPENAI_MODEL`、`OPENAI_CONTEXT_WINDOW`。
