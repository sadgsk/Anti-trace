# cli-agent

参考 `../pi` 逐步构建的个人 CLI agent，目标是可开源、可持续演进的产品级 agent。现有 `Harness`、线性 jsonl 会话、四个工具和上下文压缩已接入新 REPL；`npm start` 可交互对话。新输入支持多行编辑、粘贴合并、长文本/图片引用、撤销和重做，输入迁移功能已完成。整体设计与验收边界见 [架构书](docs/architecture.md)，开发历史与待办见 [进度文档](docs/progress.md)。

换对话先看 **[docs/progress.md](docs/progress.md)**，再按 **[docs/architecture.md](docs/architecture.md)** 对照。

思考等级与 BYOK 的后续开发见 [BYOK build 文档](docs/byok-build.md)：参考新版 TypeScript Kimi Code 与 CC Switch，按批实现并 review。第 01 批已确认；第 02 批已提交，`byok.ts` 主体的 review 尾项保留。第 03＋04 批统一适配器与 Chat 思考链已实现，待 review。Responses（05＋06）和 Anthropic（07＋08）各按一个完整协议批次规划，尚未开始；思考控制命令、逐请求动态凭据、压缩设置统一和会话选择恢复仍待实现。

使用 Node.js 22 或更新版本，运行 `npm install`。BYOK JSON 是唯一的启动模型配置入口，模型、地址、窗口和输出上限统一在 JSON 中填写。

将 [byok.example.json](byok.example.json) 复制为项目根目录的 `byok.json`，填写实际 API key、地址、上游模型 ID 和窗口／输出上限，然后运行 `npm start`。`currentModel` 选择 `models` 中的目录键，模型通过 `connection` 引用连接。CLI 默认读取启动 cwd 下的 `byok.json`，也可通过进程环境变量 `CLI_AGENT_CONFIG` 指定其他 JSON 文件；相对路径按 cwd 解析。文件缺失或损坏均报错。`.env`、`.env.example` 和 dotenv 读取代码已删除；本机 `byok.json` 包含凭据，已加入 Git 忽略规则，仓库只保留无真实凭据的示例。

连接的 `baseUrl` 包含接口所需版本前缀，例如 `/v1`，Chat 适配器只追加 `/chat/completions`。若使用完整推理地址，另填 `endpoint`，`baseUrl` 仍必填。`thinking.effort` 保存固定五档，省略 `enabled` 使用服务端默认；明确开启或关闭时按 `adapter.thinking` 编码，缺规则或无法关闭则在 HTTP 前报错。连接可设 adapter 默认，模型可覆盖；支持 effort、开关和五档预算模板，以及输出字段、usage 和同来源思考回传选择。详细配置与示例见 [Chat adapter 配置](docs/byok-build.md#62-第-0304-批的-chat-adapter-配置)。不要仅因上游模型同名就给网关套原厂参数。

统一入口为 `streamModel()`；Chat 已解析字符串 `reasoning_content`（可配置为 `reasoning`）并保存完整结束后的 replay。历史回传默认省略，明确配置后仅发送同模型／连接／实际 endpoint 的合法数据。截断、错误和取消不会生成可回传数据；流缺少结束原因时明确失败。思考事件已进入 Agent，CLI 的思考显示仍在后续批次，隐藏显示与关闭计算互相独立。

Enter 提交；Shift/Alt+Enter 或反斜杠后 Enter 换行。Ctrl+Z 撤销，Ctrl+Y 或可识别的 Ctrl+Shift+Z 重做；Ctrl+C 中断生成或清空草稿，空闲空草稿时退出；Ctrl+D 退出。上下键只在当前输入中移动。可粘贴图片路径，Windows 用 Alt+V、macOS/Linux 用 Ctrl+V 读取图片剪贴板。修饰键识别取决于终端提供的编码。

`/help` 查看命令，`/new` 开始新会话，`/resume` 列出会话后输入序号，`/context [正整数]` 查看或调整窗口，`/compact` 尝试手动压缩，`/exit` 退出。非 TTY 输入到 EOF 后作为一条完整消息提交，例如 `printf '解释这段代码\n第二行' | npm start`。

运行 `npm run typecheck` 和 `npm run build` 验证。按用户要求，整个 `test/` 目录均只保留在本地，已从 Git 取消跟踪并删除对应的 npm 测试／探针入口；后续在近期两个功能点完成后另建测试框架。此前完整链路通过本机 HTTP SSE 与 macOS POSIX PTY 验收，真实剪贴板、Windows/Linux 原生终端和具体终端应用仍需手测。旧输入 `stash` 和旧同步 `utils/image.ts` 已删除。
