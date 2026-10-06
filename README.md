# cli-agent

参考 `../pi` 逐步构建的个人 CLI agent，目标是可开源、可持续演进的产品级 agent。现有 `Harness`、线性 jsonl 会话、四个工具和上下文压缩已接入新 REPL；`npm start` 可交互对话。新输入支持多行编辑、粘贴合并、长文本/图片引用、撤销和重做。输入设计与验收边界见 [输入迁移计划](docs/claude-code-input-architecture.md)，整体设计见 [架构书](docs/architecture.md)，开发历史与待办见 [进度文档](docs/progress.md)。

换对话先看 **[docs/progress.md](docs/progress.md)**，再按 **[docs/architecture.md](docs/architecture.md)** 对照。

使用 Node.js 22 或更新版本，运行 `npm install`。将 `.env.example` 复制为 `.env`，填写 `OPENAI_API_KEY`、`OPENAI_BASE_URL`、`OPENAI_MODEL` 和模型窗口 `OPENAI_CONTEXT_WINDOW`，然后运行 `npm start`。当前协议为 OpenAI Chat Completions，思考等级和 BYOK 三协议配置仍待实现。

Enter 提交；Shift/Alt+Enter 或反斜杠后 Enter 换行。Ctrl+Z 撤销，Ctrl+Y 或可识别的 Ctrl+Shift+Z 重做；Ctrl+C 中断生成或清空草稿，空闲空草稿时退出；Ctrl+D 退出。上下键只在当前输入中移动。可粘贴图片路径，Windows 用 Alt+V、macOS/Linux 用 Ctrl+V 读取图片剪贴板。修饰键识别取决于终端提供的编码。

`/help` 查看命令，`/new` 开始新会话，`/resume` 列出会话后输入序号，`/context [正整数]` 查看或调整窗口，`/compact` 尝试手动压缩，`/exit` 退出。非 TTY 输入到 EOF 后作为一条完整消息提交，例如 `printf '解释这段代码\n第二行' | npm start`。

运行 `npm run test:input`、`npm run typecheck` 和 `npm run build` 验证；测试命令只引用仓库已有的基础输入测试。本轮完整链路另通过本机 HTTP SSE 与 macOS POSIX PTY 验收，新增测试和 PTY 辅助脚本按用户要求只保留在本地。真实剪贴板、Windows/Linux 原生终端和具体终端应用仍需手测。旧输入 `stash` 和旧同步 `utils/image.ts` 已删除。
