# Future issues

暂时不修的 bug 都记在这里，编号 `No.1`、`No.2`… 往后加。每条要有：**Bug 号、平台、日期、项目版本、现象描述**。不要写当时的修法或猜测，修的时候以当时代码为准。

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

**问题原因**

`src/tools/bash.ts` 在 Windows 上把 shell 改成了 `cmd.exe`（Pi 原版是找真正的 bash）。工具仍叫 `bash`，系统提示也没按平台告诉模型用 cmd 语法，所以 LLM 会发 `rm` / `ls` / `find` 这类 bash 命令。cmd 执行失败或挂起，删除就走不通。

（v1.2 第 0 步搬家后，该文件在 `src/harness/tools/bash.ts`，函数体未改。）

---

## No.2 — Windows 上删除粘贴后再粘贴新内容，粘贴表里仍是旧内容

| 项 | 值 |
|---|---|
| Bug | No.2 |
| 日期 | 2026-10-09 |
| 平台 | Windows（本机 `win32`）。 |
| 项目版本 | v1.2（`package.json` `0.1.0`）。 |
| 仓库快照 | `main` `a671ff1`（`https://github.com/sadgsk/Anti-trace.git`）。 |

**问题描述**

在 REPL 输入框里，先把一段内容粘贴进草稿（长文本会折成 `[Pasted text #N]` 之类的引用占位，内容存在输入组件内部的粘贴表里），再把它删掉；随后复制一段新的内容再次粘贴时，新粘贴的内容没有被登记进粘贴表，粘贴表里保存的还是上一次被删掉的旧内容。

表现出来就是：重新粘贴后引用指向的内容仍是旧的，提交出去的不是当前复制的新内容。

**影响**

删除粘贴引用后再次粘贴不可信，需要靠 `/new` 或整段清空才能绕开；无法在草稿里连续替换多次粘贴内容。

**问题原因**

未定位。仅记录实际使用中碰到的现象，修的时候以当时代码为准。
