# cli-agent

参考 `../pi` 逐步构建的个人 CLI agent，目标是可开源、可持续演进的产品级 agent。当前 `Harness`、线性 jsonl 会话、四个工具及上下文压缩等核心模块仍在；旧交互输入已归档，`npm start` 暂时不可用于对话。新输入按 [Claude Code 输入架构迁移计划](docs/claude-code-input-architecture.md) 分批建设。项目其余设计见 [架构书](docs/architecture.md)，开发历史和待办见 [进度文档](docs/progress.md)。

换对话先看 **[docs/progress.md](docs/progress.md)**，再按 **[docs/architecture.md](docs/architecture.md)** 对照。

现阶段可运行 `npm run typecheck` 和各模块探针。`npm run test:input:stash` 只验证归档的旧输入；它不代表新输入已经接通。交互入口完成并验收后，再恢复 `npm start` 的使用说明。
