# Anti-trace

**中文** | [English](README.en.md)

Anti-trace 是一个终端 AI 助手，支持接入不同模型，提供文件读写、命令执行、会话恢复和上下文管理等功能。

项目目前处于早期开发阶段，后续计划支持通过自然语言修改工具和 CLI 界面，并通过热启动使修改生效。

![Anti-trace 预计架构：现有 CLI agent 基础与计划中的功能修改、验证和热启动流程（英文）](docs/assets/target-architecture.svg)

## 项目目标

用户用自然语言描述想增加或修改的功能，由 agent 理解需求、规划和实施变更，再通过热启动让新的功能生效。修改范围包括工具（tools）、CLI 界面及其他 agent CLI 功能；具体变更机制、验证方式与热启动流程仍待设计和实现。

当前先完善支持这一目标的基础：模型接入、工具执行、会话管理、上下文管理和终端交互。下文列出已实现的能力与后续计划，产品目标不代表功能已全部完成。

项目从阅读和参考 [Pi](https://github.com/earendil-works/pi) 起步，部分基础代码参考并改写自 Pi，使用自己的 `Harness` 和功能设计，当前不依赖 Pi 的运行时包。整体设计见 [架构书](docs/architecture.md)。

## 已实现的能力

| 能力 | 当前实现 |
|---|---|
| 对话与工具 | 多轮对话、流式输出、取消生成，以及 `read` / `write` / `edit` / `bash` 工具 |
| 会话管理 | 按工作目录保存线性 JSONL 会话，通过 `/new` 和 `/resume` 新建或恢复会话 |
| 上下文管理 | 配置窗口、显示用量、自动摘要压缩和手动 `/compact` |
| 终端输入 | 多行编辑、粘贴合并、长文本与图片引用、撤销和重做 |
| 协议适配 | OpenAI Chat Completions、OpenAI Responses、Anthropic Messages 的请求与流式处理 |
| 模型配置 | BYOK JSON、本次运行中的模型选择与配置重载，以及通过 JSON 配置思考开关和五档偏好 |

以上能力对应当前 `main` 分支。厂商连接预设、思考控制命令、逐请求凭据读取、压缩设置统一和会话设置恢复正在开发，尚未合入主分支；开发计划见 [BYOK build](docs/byok-build.md)。

## 后续计划与待合入工作

- [ ] 根据一句话需求，规划并实施对工具、CLI 界面等功能的动态修改。
- [ ] 设计功能变更的验证流程，并通过热启动应用变更。
- [ ] 合入正在开发的厂商连接预设、思考控制命令与统一设置链路。
- [ ] 建立可复现的测试框架，覆盖三种协议的端到端验收。
- [ ] 处理已记录的中断后工具配对、Windows 命令执行和上下文溢出错误显示问题。
- [ ] 补充真实模型、多平台终端和剪贴板的使用验证，按需增加模型绑定。
- [ ] 在 v1.3 完善 TUI 交互。

以上功能尚未全部在主分支提供，部分正在本地开发，没有承诺完成日期。详细进度和验收记录见 [progress.md](docs/progress.md)。

## 快速开始

需要 Node.js 22 或更新版本，以及所选模型服务的 API 访问权限和密钥。

1. 克隆仓库并进入项目目录，运行 `npm install`。
2. 将 [byok.example.json](byok.example.json) 复制为项目根目录的 `byok.json`。
3. 填写连接的 API key、地址，以及模型 ID、上下文窗口和输出上限；用 `currentModel` 选择要使用的模型键。示例默认的 `main` 使用占位地址和模型 ID，需要先替换。
4. 运行 `npm start`，输入 `/help` 查看可用命令。

工具能够读取、写入和编辑文件，并执行本地命令，操作会影响当前工作目录。建议先在可恢复的项目副本中试用。

## 模型与配置

BYOK JSON 是唯一的启动模型配置入口，模型、地址、窗口和输出上限统一在 JSON 中填写。`currentModel` 选择 `models` 中的目录键，模型通过 `connection` 引用连接。CLI 默认读取启动 cwd 下的 `byok.json`，也可通过进程环境变量 `CLI_AGENT_CONFIG` 指定其他 JSON 文件；相对路径按 cwd 解析。

`byok.json` 已加入 Git 忽略规则，请勿将实际密钥提交到仓库；提供的示例仅包含占位密钥。连接也可使用 `apiKeyEnv` 引用进程环境变量，不读取 `.env` 文件。

连接的 `baseUrl` 包含接口所需版本前缀，例如 `/v1`，三协议分别追加 `/chat/completions`、`/responses`、`/messages`，不再追加 `/v1`。若使用完整推理地址，另填 `endpoint`，`baseUrl` 仍必填。`thinking.effort` 保存固定五档，省略 `enabled` 使用服务端默认；明确开启或关闭时按 `adapter.thinking` 编码，缺规则或无法关闭则在 HTTP 前报错。连接可设 adapter 默认，模型可覆盖；支持 effort、开关和五档预算模板，以及输出字段、usage 和同来源思考回传选择。详细配置见 [Chat adapter 配置](docs/byok-build.md#62-第-0304-批的-chat-adapter-配置)。不要仅因上游模型同名就给网关套原厂参数。

三协议都使用统一入口 `streamModel()`；Chat 解析字符串 `reasoning_content`（可配置为 `reasoning`），并保存完整结束后的思考回传数据。历史回传默认省略，明确配置后仅发送同模型／连接／实际 endpoint 的合法数据。截断、错误和取消不会生成可回传数据；流缺少结束原因时明确失败。思考事件已进入 Agent，CLI 的思考显示仍待合入。

## 交互与命令

Enter 提交；Shift/Alt+Enter 或反斜杠后 Enter 换行。Ctrl+Z 撤销，Ctrl+Y 或可识别的 Ctrl+Shift+Z 重做；Ctrl+C 中断生成或清空草稿，空闲空草稿时退出；Ctrl+D 退出。上下键只在当前输入中移动，不提供历史召回。可粘贴图片路径，Windows 用 Alt+V、macOS/Linux 用 Ctrl+V 读取图片剪贴板。修饰键识别取决于终端提供的编码。

`/help` 查看命令，`/new` 开始新会话，`/resume` 列出会话后输入序号，`/context [正整数]` 查看或调整窗口，`/compact` 尝试手动压缩，`/exit` 退出。非 TTY 输入到 EOF 后作为一条完整消息提交，例如 `printf '解释这段代码\n第二行' | npm start`。

当前通过 BYOK JSON 的 `thinking` 配置思考开关与 effort 偏好。交互式思考控制命令、思考显示和会话设置恢复仍待合入。

Harness 始终启动，不依赖是否配置模型。缺文件或配置有误时会显示具体原因，`/new`、`/resume`、`/context` 查看用量和帮助仍可使用；没有可用模型时，只在聊天、压缩或修改模型窗口时提示先配置模型。未配置的窗口显示为“未配置”，不会填充假模型。

编辑 JSON 修正配置后输入 `/reload`，无需重启。这里的 `/reload` 仅重载模型配置，不会动态修改工具或 CLI 界面，也不是计划中的功能热启动。`/config` 查看当前状态，`/config <路径>` 更换文件，`/model <模型键>` 选择本次运行使用的模型。`/model` 不带参数时显示用法及已加载模型键；切换成功简短确认，失败显示原因。加载时校验结构、引用、地址和参数约束，候选无效则保留原来生效的配置、消息和会话。选择和路径不自动写回 JSON；更换文件时使用该文件的默认模型。

启动和重载不验证远端可用性，也不提前解析环境 key。聊天／摘要操作在需要凭据时读取 `apiKeyEnv`；缺 key、请求参数无法编码以及 HTTP 错误会显示在 CLI 中，结束本次操作后可继续输入。外部终端新设的环境变量不会自动进入已运行进程，可改用文件内的凭据来源后重载。管道也先读取完整输入：配置诊断写入 stderr，会话命令仍可成功；需要模型的操作失败才返回退出码 1。

Responses 使用 `store: false` 与完整 input 历史，保存并按来源回传加密 reasoning item；支持文本、图片、工具增量、usage 和终止状态。Anthropic 使用 `x-api-key`、`anthropic-version` 和必需的输出上限，支持预算／自适应思考、完整签名与 redacted-thinking、工具结果和缓存用量合计。两者默认 `reasoningReplay: "same-source"`，只在完整成功后保存可回传数据。配置及初始模型绑定见 [Responses／Anthropic 配置](docs/byok-build.md#63-responsesanthropic-配置与初始绑定)。示例同时提供两种协议的连接和模型；选择对应目录键、填写凭据后即可使用。

## 当前限制与验证范围

- 当前交互入口为 REPL，完整 TUI 仍在后续计划中。
- Windows 上的 `bash` 工具实际使用 `cmd.exe`，存在已记录的命令执行失败和卡住问题，见 [future-issues.md](docs/future-issues.md)。
- 中断后的工具配对和可恢复的上下文溢出错误提前显示问题仍待处理，见 [评审记录](docs/review-records.md)。
- 已有本机 HTTP SSE 与 macOS POSIX PTY 验收记录；真实模型、地区账户、剪贴板及其他平台终端的验证仍不完整。
- 现有零散测试仅保留在本地，仓库尚未提供可复现的自动化测试套件。`npm run typecheck` 和 `npm run build` 分别用于类型检查与构建，不替代完整功能测试。

## 开发文档

- [开发进度](docs/progress.md)：当前状态、待办与历史记录，继续开发时先读这一页。
- [架构书](docs/architecture.md)：模块职责、当前设计、后续目标与验收边界。
- [运行主流程](docs/main-flow.md)：从 Enter 提交到模型请求、工具循环和结束的流程图与时序图。
- [BYOK build](docs/byok-build.md)：配置与适配器设计、交付及评审记录。

## 许可证

本项目采用 [MIT 许可证](LICENSE)。源自 Pi 的部分保留其原有版权和许可声明。
