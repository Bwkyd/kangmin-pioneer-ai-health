# GitHub 仓库治理

## 当前服务端能力

- 仓库为私有仓库。
- GitHub Actions 已限制为选定的 GitHub 官方 Action。
- Action 必须使用完整提交 SHA。
- Dependabot 漏洞提醒和自动安全修复已启用。
- `main` 服务端分支保护因当前 GitHub 套餐限制无法启用。

GitHub API 返回：私有仓库需升级 GitHub Pro，或改为公开仓库，才能使用 Branch Protection/Rulesets。公开仓库会改变客户项目的访问边界，不能作为默认解决方式。

## 当前替代门禁

运行一次：

```bash
npm run setup:git
```

这会安装仓库级 `pre-push` 钩子，阻止本机和共享 worktree 直接推送 `main`。它是本地防误操作措施，不等于 GitHub 服务端保护；拥有其他克隆的人仍可绕过。

## 升级套餐后的启用方式

```bash
scripts/configure-branch-protection.sh
```

目标规则：

- 所有变更必须通过 PR；
- 分支必须与最新 `main` 保持同步；
- 必须通过 `quality`；
- 管理员同样受规则约束；
- 禁止 force push 和删除 `main`；
- 要求线性历史并解决所有讨论。

启用后用 GitHub API 或仓库设置页复核，不以脚本退出码代替最终状态确认。
