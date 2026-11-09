# 测试与 CI

正式测试位于 `tests/`，与源码、配置和依赖锁文件一起纳入 Git。旧 `test/` 已退役并移出项目，其历史探针、实验和验收产物不参与自动发现。新增功能同步维护对应测试；修复 bug 时先增加能复现问题的回归用例。

## 本地命令

开发测试使用当前 Node 22（至少 22.12）或 Node 24。首次安装使用 `npm ci --ignore-scripts`。

| 命令 | 用途 |
|---|---|
| `npm test` | 全部离线测试，包含独立 CLI 进程测试 |
| `npm test -- agent-lifecycle` | 文件路径包含该文字的测试 |
| `npm test -- tests/integration/session.test.ts` | 指定文件 |
| `npm test -- session.test --name "new and resume"` | 同时筛选文件和用例名称 |
| `npm run test:unit` | 单元测试 |
| `npm run test:integration` | 集成测试和回归测试 |
| `npm run test:tui` | 终端界面与交互测试 |
| `npm run test:e2e` | 在独立进程中启动真实 CLI |
| `npm run test:watch -- unit` | 监听文件变化，Ctrl+C 退出 |
| `npm run typecheck` | 产品源码类型检查 |
| `npm run test:types` | 源码、测试和共享测试工具的类型检查 |
| `npm run test:coverage` | 全量测试和覆盖率门槛检查 |
| `npm run check` | 源码类型、测试类型、全量测试和构建 |

运行器使用 Node 枚举 `.test.ts` 和 `.test.tsx`，不依赖系统 shell 的通配符。不匹配任何文件、用例失败、未处理错误和超时均返回非零退出码。

## 目录与覆盖范围

```text
tests/
  unit/           文本状态、输入解析、粘贴、上下文、权限、测试隔离
  integration/    三种模型协议、配置恢复、Agent、工具、会话、压缩
  tui/            React/Ink、模拟终端、菜单、渲染、缩放和历史回看
  e2e/            独立 CLI 进程、管道输入、退出码、权限拒绝
  regressions/    中断后的工具配对、接口错误凭据脱敏等具体问题
  support/        测试 Harness、模型替身、HTTP 服务、临时目录和等待工具
  live/           显式运行的真实模型检查，后缀为 .live.ts
```

| 模块 | 已纳入的主要行为 |
|---|---|
| 配置与模型 | schema、引用、预设、思考设置、逐请求凭据、无配置启动、修复和失败重载 |
| 三种协议 | 实际请求编码、本地 HTTP/SSE、UTF-8 分片、工具参数、思考回传、usage、错误、取消 |
| Agent | 普通回答、多工具、工具失败、参数校验、截断保护、并发操作、中断后继续 |
| 工具 | 文件创建／覆盖、行号／截断、精确编辑、歧义／重叠拒绝、Shell 输出／错误／超时 |
| 会话与上下文 | 延迟落盘、恢复、损坏数据、项目隔离、压缩切点、自动压缩、摘要失败和重试 |
| 权限 | 三种模式、精确命令授权、会话重置、拒绝、反馈、中断和审批释放 |
| CLI / TUI | 管道与进程退出、草稿、输入字节、粘贴、图片、菜单、配置表单、语言、缩放、历史缓存 |

## 环境隔离

`scripts/run-tests.mjs` 每次创建独立的 HOME、用户配置、缓存、临时目录和工作目录，只传递必要的平台环境变量，不继承 API key、代理、`NODE_OPTIONS` 或 `CLI_AGENT_CONFIG`。结束后清理本次创建的根目录。

`support/setup.ts` 在加载产品代码前拦截 Node socket 连接，默认只允许回环地址。协议测试使用真实的本地 HTTP 服务，其余模型行为由 `streamFn` 替身驱动。独立 CLI 子进程也加载该限制。这用于防止测试误连远端，不是针对不可信代码的系统级网络沙箱。

Fake TTY 统一使用 `CI=false` 模拟用户终端，因为 Ink 在 `CI=true` 时会延迟输出交互帧。GitHub Actions 本身正常运行 CI；另有独立进程用例显式设置 `CI=true` 检查管道输出。测试文件顺序运行，避免全局 fetch 替换和 React/Ink 实例竞争。

终端视口的布局准备和绘制是异步的。检查流式文本、滚动、展开和缩放时，先用 `waitFor` 等待目标终端帧或对应布局完成，再保留内容、宽度和锚点断言；不要用固定的 75／80 毫秒推断界面已完成。真实终端测试直接读取宿主写出的同步帧，避免给同一会话挂第二个 `ReplScreen`，由两个视口同时回写滚动指标。

## 编写新测试

优先沿用同类文件和 `support/`，检查公开行为、真实结果和失败后的状态。

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { createTestHarness, messageText } from "../support/harness.ts";

test("完成对话后恢复空闲", async (t) => {
  const { harness, agent } = createTestHarness(t, [{ text: "hello" }]);
  await harness.prompt("hi");
  assert.equal(messageText(agent.state.messages.at(-1)), "hello");
  assert.equal(agent.state.isStreaming, false);
});
```

`createTestHarness()` 提供临时项目、真实 Harness/Agent、事件快照和自动清理。`scripted.requests` 保存模型请求；响应步骤可以是文本、工具调用、错误，或者检查请求后返回响应的函数。同步异步操作使用 `deferred()`；等待渲染使用 `waitFor()`，不要猜测机器需要多久。

文件操作使用 `tempWorkspace(t)`。协议测试使用 `createHttpFixture(t, handler)` 的随机端口和请求记录。所有数据使用合成凭据；临时配置、会话和服务在结束时清理。平台特有用例明确标注 `process.platform` 条件，不能为了 CI 通过而跳过通用功能或删除断言。

## 覆盖率与 CI

c8 使用源码映射生成覆盖率，并把从未导入的源码计入分母。报告位于忽略的 `coverage/`，包括 HTML、LCOV 和 JSON。全量门槛：行／语句／函数至少 85%，分支至少 80%。覆盖率命令用于全量检查，筛选调试使用 `npm test`。行为清单和关键回归仍是验收依据，百分比不代表所有场景均已覆盖。

`.github/workflows/ci.yml` 使用 GitHub 官方 Actions，在分支 push、pull request、手动触发，以及由 Release 工作流调用时运行 Windows、Linux、macOS × Node 22、24，共六个独立任务。每个任务安装锁定依赖、检查源码与测试类型、构建、执行全量测试和覆盖率检查，并上传报告保存七天。单个任务失败不会取消其余平台检查。版本 tag 由 Release 统一检查，避免重复运行相同矩阵；自动发布和账号绑定见 [npm 自动发布](releases.md)。

需要把 CI 设为合并必需项时，由维护者配置仓库分支规则，工作流不会修改仓库设置。本机和远程验证分开记录；Linux/macOS 的通过状态以 Actions 实际执行结果为准。

## 真实模型验证与边界

真实模型检查通过独立入口显式运行，默认测试和 CI 不读取真实配置、不消费模型额度：

```sh
npm run test:live -- --config /path/to/byok.json --model main
```

仅发送一次合成文字请求，无工具和会话写入；默认最多输出 256 token，请求超时 30 秒。可用 `--max-tokens 2048` 调整需要更多推理预算的模型。该入口验证实际接入，任务成功率、提示词对照等评测在有明确任务集后单独扩展。

原生剪贴板、具体终端外观仍需对应环境验收。Shell 测试覆盖默认超时、关闭标准输入、取消和有界输出排空；Windows CI 必须具备 Git Bash、PowerShell 5.1／7，并实际执行中文与空格路径删除、退出码、后代进程清理，以及 CMD 启动 CLI 后的 PowerShell 工具往返。缺少必需 shell 时用例失败；这些 Windows 专用用例仅在其他平台跳过。无 Git Bash 的探测和工具装配另有独立覆盖。见 `future-issues.md` No.1。
