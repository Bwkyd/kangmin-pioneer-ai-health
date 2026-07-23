# Agent 自动化开发 Runbook

## 标准流程

```text
Issue 确认
  → 独立分支/worktree
  → 实现与本地门禁
  → Draft PR
  → CI quality
  → 风险对应的审核
  → 明确授权合并
  → main 核验
  → Issue 关闭
  → 授权后清理 worktree/分支
```

## 创建任务环境

```bash
scripts/worktree-create.sh 123 short-slug
cd .worktrees/issue-123-short-slug
npm ci
```

脚本以最新 `origin/main` 为基线创建：

- 分支：`codex/issue-123-short-slug`
- 路径：`.worktrees/issue-123-short-slug`

`WORKTREE_BASE_REF` 仅用于受控测试或明确指定其他已验证基线；正常开发不要覆盖默认值。

## 任务计划

复制 `docs/plans/TEMPLATE.md` 到 `docs/plans/active/issue-123-short-slug.md`，持续记录范围、状态、负责人、测试证据、阻塞项和候选提交 SHA。

## 提交与 PR

只暂存任务范围内的文件。提交前运行：

```bash
npm run check
git diff --check
```

PR 默认 Draft，并使用仓库模板关联 Issue。CI 通过后仍需按任务风险获得审核和合并授权。

## 收尾审计

```bash
scripts/worktree-audit.sh .worktrees/issue-123-short-slug
```

只有在以下条件同时满足后才可申请清理：

- PR 已合并；
- `main` 已核验包含最终 Git tree；
- worktree 无未提交文件；
- 分支没有未保留的独有成果；
- 用户明确授权清理。

脚本只读，不会自动删除 worktree 或分支。
