# Anti-trace

[![MIT License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![npm version](https://img.shields.io/npm/v/anti-trace)](https://www.npmjs.com/package/anti-trace)
[![CI](https://github.com/sadgsk/Anti-trace/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/sadgsk/Anti-trace/actions/workflows/ci.yml)
[![Release](https://github.com/sadgsk/Anti-trace/actions/workflows/release.yml/badge.svg)](https://github.com/sadgsk/Anti-trace/actions/workflows/release.yml)
<br>
[快速开始](#快速开始) · [文档](#文档) · [Issues](https://github.com/sadgsk/Anti-trace/issues) · [English](README.en.md)

Anti-trace 是一个运行在终端里的 AI 编程助手。它能读取和修改项目文件、运行构建与测试，并根据工具返回的结果继续排查。你可以用自己的 API 密钥接入支持的模型服务，在终端查看命令、输出和文件差异。

## 安装

需要 Node.js 22 或更新版本。

```sh
npm install -g anti-trace
```

`ati` 和 `anti-trace` 是等价的启动命令。macOS 和 Linux 的命令工具使用 Bash。Windows 优先使用 PowerShell 7，找不到时使用 Windows PowerShell 5.1。安装 Git for Windows 后也可使用 Git Bash，若安装路径未被识别，可将 `ANTI_TRACE_GIT_BASH_PATH` 设为 Git for Windows 中 `bin\bash.exe` 的绝对路径。

## 快速开始

1. 在终端进入你的项目目录，启动 Anti-trace。

   ```sh
   cd your-project
   ati
   ```

2. 输入 `/config`，选择「新增配置文件」。填写配置文件名、服务商的 API URL、API Key、模型 ID 和接口协议。按模型规格设置上下文窗口，可按需填写最大输出。选择「保存并使用此配置」或按 `Ctrl+S`。
3. 输入你的第一个任务。

   ```text
   找到这个项目的入口和测试命令，解释主要模块之间是怎么配合的。
   ```

已配置模型后，也可以通过管道提交一条提示词。CLI 会读取完整的标准输入，执行一次并退出。管道模式会阻止需要交互审批的工具调用。

```sh
echo "Explain the entry points in this project." | ati
```

## 主要功能

- **读写代码与执行命令。** 读取、创建和编辑文件，通过 Shell 搜索项目、运行构建与测试。Shell 命令默认超时为 120 秒，过长的输出会截取展示，并保存完整内容供后续读取。
- **终端交互。** 流式展示模型回复，支持 Markdown、代码高亮、表格、工具卡片和文件差异。输入 `/` 打开命令菜单，输入 `@` 搜索并补全工作区文件。可编辑多行草稿、撤销和重做，也可用 `/language` 切换中英文界面。
- **图片输入。** 粘贴图片文件路径，或用 `Alt+V`（Windows）和 `Ctrl+V`（macOS／Linux）尝试读取剪贴板图片。支持 PNG、JPEG、GIF 和 WebP，剪贴板读取取决于终端和系统工具，所选模型也须支持图片输入。
- **会话与上下文。** 按项目保存对话和图片附件，用 `/resume` 继续之前的会话。状态栏显示上下文用量，长会话可自动压缩旧内容，也可用 `/compact` 手动尝试压缩。

## Skills

用 `/skill` 打开技能二级菜单；带参数提示的技能先填写参数，再执行。也可输入 `/skill review 当前分支`；`/skill --reload` 显示加载结果和诊断。具体技能不会成为一级命令。

项目技能放在 `cwd/.anti-trace/skills/<name>/SKILL.md`，只读取当前工作目录，不向父目录查找。用户技能放在 `~/.anti-trace/skills/<name>/SKILL.md`（随 `ANTI_TRACE_HOME` 改变，跨项目和 profile 共用）。同名技能项目优先。

系统提示词会提供这两个实际目录和文件格式，即使当前还没有技能也会提供。可以直接在对话中要求创建技能，默认写入项目目录；要求个人或跨项目使用时写入用户目录，使用现有文件／Shell 工具创建，下一次模型请求前自动发现。

```markdown
---
name: review
description: 审查代码修改。当用户要求检查代码或寻找回归时使用。
argument-hint: "[审查范围]"
---

审查范围：$ARGUMENTS
读取当前修改及相关调用方，报告可确认的问题、严重程度和文件位置。
```

名称须与目录一致，使用小写字母、数字和连字符；描述和正文必填。附属脚本、参考资料和模板可放在同目录，由模型使用已有工具访问。支持 `$ARGUMENTS`、`$0`、`$ARGUMENTS[0]`、`arguments` 命名参数，以及 `${CLAUDE_SKILL_DIR}`、`${CLAUDE_SESSION_ID}`。

用现有文件／Shell 工具即可创建技能。打开菜单和每次模型请求前都会重新发现技能。模型先收到名称和描述，调用统一的 `skill` 工具后才收到完整说明。`disable-model-invocation: true` 禁止模型调用；`user-invocable: false` 隐藏手动入口。正文随会话保存，压缩后按预算恢复。

`allowed-tools` 支持 `read`、`edit`、`write`、`bash`、`powershell` 的名称或列表（兼容对应首字母大写名称），仅本轮有效。模型选择带授权的技能需要审批；用户手动选择表示使用该技能声明的本轮授权。恢复会话不恢复授权。其他操作沿用现有权限策略。

当前支持 inline 技能。不支持命令匹配授权、动态 Shell 注入、路径条件、专属模型／effort、fork、Hooks 和插件来源；依赖这些能力的技能会显示加载诊断。

## 权限与审批

默认允许读取文件。写入、编辑和 Shell 命令会弹出审批，可以允许一次、在本会话内授权，或拒绝并给出修改意见。审批时可预览待写入的文件差异。会话授权对文件修改类操作生效，Shell 授权仅匹配同一工具中的相同命令。

| 模式 | 行为 |
| --- | --- |
| 默认 | 审批写入、编辑和 Shell 命令 |
| `auto-edit` | 自动允许写入和编辑，Shell 命令仍需审批 |
| `yolo` | 自动允许所有工具调用 |

按 `Shift+Tab` 切换模式，也可用 `ati --auto-edit` 或 `ati --yolo` 指定启动模式。工具使用当前用户的系统权限执行。

## 模型配置

可通过 `/config` 新增、选择和编辑配置文件。一个配置可以包含多个模型，用 `/model` 切换。支持以下接口。

| 接口 | JSON 中的 `api` |
| --- | --- |
| OpenAI Chat Completions | `openai-completions` |
| OpenAI Responses | `openai-responses` |
| Anthropic Messages | `anthropic-messages` |

也可将 [配置示例](byok.example.json) 复制到 `~/.anti-trace/profiles/local/configs/main.json`，替换示例地址、密钥和模型 ID，再按模型规格设置 `contextWindow` 和可选的 `maxOutputTokens`。`models` 中的每个模型通过 `connection` 引用 `connections` 中的连接，`currentModel` 填写要使用的模型配置键。

- 每个连接填写 `apiKey` 或 `apiKeyEnv` 二者之一。`apiKeyEnv` 引用启动 CLI 的进程环境变量。也可从 [服务商预设示例](byok.providers.example.json) 选取连接。
- `baseUrl` 填写服务的 API 基址，包含所需的版本前缀（如 `/v1`）。如需指定完整推理地址，将其填入 `endpoint`。
- 启动时依次尝试 `CLI_AGENT_CONFIG` 指定的配置、当前项目上次选择、用户默认选择、配置目录中唯一有效的配置。首次遇到多个有效配置时，可用 `/config` 选择。
- 本地数据目录默认为 `~/.anti-trace`，可用 `ANTI_TRACE_HOME` 覆盖。模型配置位于 `profiles/local/configs/`，会话、附件和长工具输出按工作目录归档到 `profiles/local/projects/`。

## 命令与快捷键

输入 `/` 后可继续输入以筛选命令，用方向键选择，按 `Enter` 确认、`Tab` 补全、`Esc` 关闭。

| 命令 | 用途 |
| --- | --- |
| `/help` | 查看命令和快捷键 |
| `/new` / `/resume` | 开始新会话或恢复当前项目的已有会话 |
| `/config [路径]` | 管理配置，或直接加载指定 JSON 文件 |
| `/model [模型键]` | 从当前配置中选择模型 |
| `/reload` | 重新读取当前配置 |
| `/thinking [on\|off\|default]` | 开启、关闭模型思考，或使用服务商默认值 |
| `/effort` | 选择思考档位，支持 `low`、`medium`、`high`、`xhigh`、`max`，实际效果取决于模型与接口 |
| `/thinking-display [on\|off]` | 设置思考文本是否默认展开 |
| `/context [正整数]` / `/compact` | 查看或调整上下文窗口，或尝试压缩上下文 |
| `/language [zh\|en]` | 切换并记住界面语言 |
| `/skill [技能名 参数\|--reload]` | 技能二级菜单、执行技能或重新加载 |
| `/exit` | 退出 |

| 快捷键 | 用途 |
| --- | --- |
| `Enter` / `Shift+Enter` 或 `Alt+Enter` | 提交 / 换行 |
| `Ctrl+Z` / `Ctrl+Y` 或 `Ctrl+Shift+Z` | 撤销 / 重做草稿修改 |
| `Ctrl+C` | 中断生成或清空草稿，空闲且草稿为空时退出 |
| `Ctrl+O` | 展开或收起工具输出和思考文本 |
| 滚轮或 `PgUp` / `PgDn` / `Ctrl+End` | 回看对话 / 返回最新输出 |

快捷键能否被识别取决于终端。

## 开发

```sh
git clone https://github.com/sadgsk/Anti-trace.git
cd Anti-trace
npm ci
npm start
```

`npm test` 运行离线测试，`npm run check` 运行类型检查、测试和构建。推送分支或提交 Pull Request 会触发 GitHub Actions，在 Windows、macOS 和 Linux 上用 Node.js 22 和 24 运行 CI。

推送 `vX.Y.Z` 格式的版本标签会触发 npm 发布流程。工作流确认标签版本与包版本一致、提交已进入 `main`，通过 CI 和安装检查后发布到 npm。

## 文档

- [测试与 CI](docs/testing.md)
- [npm 发布流程](docs/releases.md)
- [架构与实现说明](docs/architecture.md)

## 许可证

[MIT](LICENSE)。
