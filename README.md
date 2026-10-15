# cli-agent

参考 `../pi` 逐步构建的个人 CLI agent，目标是可开源、可持续演进的产品级 agent。现有 `Harness`、线性 jsonl 会话、四个工具和上下文压缩已接入新 REPL；`npm start` 可交互对话。新输入支持多行编辑、粘贴合并、长文本/图片引用、撤销和重做，输入迁移功能已完成。整体设计与验收边界见 [架构书](docs/architecture.md)，开发历史与待办见 [进度文档](docs/progress.md)。

换对话先看 **[docs/progress.md](docs/progress.md)**，再按 **[docs/architecture.md](docs/architecture.md)** 对照。

思考等级与 BYOK 的后续开发见 [BYOK build 文档](docs/byok-build.md)：参考新版 TypeScript Kimi Code 与 CC Switch，按小批次实现并逐批 review。第 01 批请求数据与运行快照已由用户 review 确认；第 02 批配置加载、模型目录和启动选择已实现并获准提交，`byok.ts` 主体待用户在 Mac 上继续 review。当前可用 JSON 配置启动 Chat 模型；另外两种协议、思考编码和运行中选择命令仍待实现，完整 BYOK 尚未完成。

使用 Node.js 22 或更新版本，运行 `npm install`。BYOK JSON 是唯一的启动模型配置入口，模型、地址、窗口和输出上限统一在 JSON 中填写。

将 [byok.example.json](byok.example.json) 复制为项目根目录的 `byok.json`，填写实际 API key、地址、上游模型 ID 和窗口／输出上限，然后运行 `npm start`。`currentModel` 选择 `models` 中的目录键，模型通过 `connection` 引用连接。CLI 默认读取启动 cwd 下的 `byok.json`，也可通过进程环境变量 `CLI_AGENT_CONFIG` 指定其他 JSON 文件；相对路径按 cwd 解析。文件缺失或损坏均报错。`.env`、`.env.example` 和 dotenv 读取代码已删除；本机 `byok.json` 包含凭据，已加入 Git 忽略规则，仓库只保留无真实凭据的示例。

连接的 `baseUrl` 包含接口所需版本前缀，例如 `/v1`，Chat 适配器只追加 `/chat/completions`。若使用完整推理地址，另填 `endpoint`，该地址原样用于请求，`baseUrl` 仍必填。当前 `thinking.effort` 保存五档选择；省略 `enabled` 使用服务端默认，明确开关尚未编码。完整字段与当前边界见 [第 02 批配置约定](docs/byok-build.md#61-第-02-批已实现的配置约定待-review)。

Enter 提交；Shift/Alt+Enter 或反斜杠后 Enter 换行。Ctrl+Z 撤销，Ctrl+Y 或可识别的 Ctrl+Shift+Z 重做；Ctrl+C 中断生成或清空草稿，空闲空草稿时退出；Ctrl+D 退出。上下键只在当前输入中移动。可粘贴图片路径，Windows 用 Alt+V、macOS/Linux 用 Ctrl+V 读取图片剪贴板。修饰键识别取决于终端提供的编码。

`/help` 查看命令，`/new` 开始新会话，`/resume` 列出会话后输入序号，`/context [正整数]` 查看或调整窗口，`/compact` 尝试手动压缩，`/exit` 退出。非 TTY 输入到 EOF 后作为一条完整消息提交，例如 `printf '解释这段代码\n第二行' | npm start`。

运行 `npm run typecheck` 和 `npm run build` 验证。按用户要求，整个 `test/` 目录均只保留在本地，已从 Git 取消跟踪并删除对应的 npm 测试／探针入口；后续在近期两个功能点完成后另建测试框架。此前完整链路通过本机 HTTP SSE 与 macOS POSIX PTY 验收，真实剪贴板、Windows/Linux 原生终端和具体终端应用仍需手测。旧输入 `stash` 和旧同步 `utils/image.ts` 已删除。
