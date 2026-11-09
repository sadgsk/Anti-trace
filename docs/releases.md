# npm 自动发布

当前 npm 包是 [`anti-trace`](https://www.npmjs.com/package/anti-trace)，GitHub 仓库是 `sadgsk/Anti-trace`。首次 `0.1.0` 已手动发布；后续稳定版本由 `.github/workflows/release.yml` 发布。

## 自动发布如何触发

推送 `v0.1.1` 这样的 Git tag 后，Release 工作流依次执行：

1. 核对 tag、`package.json` 和 `package-lock.json` 中的版本；确认该提交已包含在 `main` 中。
2. 复用 CI，完成 Windows、Linux、macOS × Node 22、24 的类型检查、构建、测试和覆盖率检查。
3. 在独立 Ubuntu runner 上重新安装锁定依赖，执行 `npm pack`，由 `prepack` 自动构建。
4. 检查安装包内容，仅安装生产依赖，实际启动 `ati` 和 `anti-trace` 执行 `/new`。
5. 使用 npm Trusted Publishing（OIDC）上传刚才验证过的同一个 `.tgz` 安装包。

普通分支 push 和 pull request 只触发 CI。发布流程支持 `vX.Y.Z` 稳定版本；预发布 tag（如 `v0.2.0-beta.1`）会被拒绝，避免误更新 npm 的 `latest`。

## 一次性绑定 npm 与 GitHub

先将工作流和 npm 发布配置合入 GitHub 的 `main`，再在 npm 网站完成绑定：

1. 登录 npm，打开 `anti-trace` 包页面的 **Settings**。
2. 找到 **Trusted Publisher / Trusted publishing**，选择 **GitHub Actions**。
3. 填写以下信息，并允许直接执行 `npm publish`。

| 字段 | 填写值 |
|---|---|
| Organization or user | `sadgsk`（GitHub 用户名，不是 npm 用户名） |
| Repository | `Anti-trace` |
| Workflow filename | `release.yml`（仅文件名） |
| Environment name | 留空；当前工作流没有声明 environment |
| Allowed actions | 允许直接发布 `npm publish` |

4. 保存设置，按网页提示完成 2FA 验证。

工作流使用 GitHub 托管 runner、Node 24 和 `id-token: write`，无需添加 `NPM_TOKEN` secret。新建的可信发布配置须在两天内完成首次成功发布；过期时需要删除后重新创建。公开仓库、公开包通过 GitHub OIDC 发布时，npm 会自动附加 provenance 来源证明。

参考：[npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/)。

## 发布下一个版本

先确认上述绑定已保存，且发布代码与工作流都已进入 `main`。在项目目录的 PowerShell 中执行：

```powershell
git switch main
git pull --ff-only
git status --short
```

确认工作区干净后，更新版本：

```powershell
npm version patch
```

若当前版本为 `0.1.0`，该命令会将两个包文件中的版本更新为 `0.1.1`，并创建一个 Git 提交和 `v0.1.1` tag。随后按顺序推送：

```powershell
git push origin main
git push origin v0.1.1
```

先推送版本提交，再推送对应 tag。以后发版将示例中的 tag 替换为这次生成的版本；不要再次推送已经发布过的 `v0.1.0` 来测试 CD。

打开 GitHub 仓库的 **Actions → Release** 查看运行结果。任何检查失败都会阻止 npm 发布；普通分支 CI 不重复运行 tag 检查，Release 自己调用完整 CI。

## 发布后验证

```powershell
npm view anti-trace version --prefer-online --registry=https://registry.npmjs.org/
npm install -g anti-trace@0.1.1 --registry=https://registry.npmjs.org/
ati
```

npm 接受上传后可能仍需几分钟处理。若暂时查不到新版本，稍后再查，避免重复执行发布。程序首次使用仍需要配置用户自己的模型 API 密钥。

## 常见失败

- **版本不一致**：用 `npm version` 同步更新包文件和 tag；不要只编辑一个文件。
- **提交不在 main**：先把发布提交合入并推送 `main`，再推送 tag。
- **CI 失败**：在 Actions 中查看失败的平台及步骤，修复后发布新的 tag。
- **npm 认证失败**：核对 GitHub 用户、仓库、文件名大小写、Environment 留空，以及是否允许直接 `npm publish`。确认使用 GitHub 托管 runner；已过期的可信发布配置需重新创建。
- **版本已存在**：npm 版本不能覆盖。更新版本后创建新 tag。
