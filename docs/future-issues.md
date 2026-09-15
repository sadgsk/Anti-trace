# Future issues

未修的问题记在这里。修的时候以当时代码为准，不要按记录里的猜测动手。

---

## No.1 — Windows 上用 bash 删文件会失败并卡住

| 项 | 值 |
|---|---|
| Bug | No.1 |
| 日期 | 2026-09-15 |
| 平台 | Windows（本机 `win32 10.0.26200`）。同一套代码在 macOS 上删除正常。 |
| 项目版本 | v1.1（`package.json` `0.1.0`）。当时已装配 `read` / `write` / `edit` / `bash`，bash 实现未改。 |
| 仓库快照 | `main` `5cca932`（`https://github.com/sadgsk/Anti-trace.git`） |

**问题描述**

REPL 里 `write` 可以写文件。让模型删本地文件（例：`test/v1.1_test.ts`）时，它只会走 `bash`，连打多次命令：

- 多次 `[bash] ok: (no output) [Command exited with code 1]`
- 中间有几次列出了目录或文件路径
- 有乱码输出，以及 `Command exited with code 1`
- 之后进程卡住，没有后续回复，回不到 `you>`

中断时出现：

- `This operation was aborted`
- Windows 控制台：`终止批处理操作吗(Y/N)?`

macOS 上同一操作（删除本地文件）一次通过，无卡死。
