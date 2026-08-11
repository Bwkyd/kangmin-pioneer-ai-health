---
name: git-reset-check-workspace
description: git reset/resync 前必须先检查工作区未提交改动并确认意图
metadata:
  type: feedback
---

执行 `git reset --hard`、`git checkout` 等可能丢弃工作区改动的命令前，先检查工作区未提交改动并确认意图。

**Why:** 2026-08-08 曾因 `git reset --hard` 误覆盖作者对 AGENTS.md/CLAUDE.md 的本地未提交修改（删除两条纪律），后按作者原意恢复。

**How to apply:** 任何破坏性 Git 操作前，先 `git status` / `git diff` 检查未提交改动；若存在改动，先确认是否保留或备份，再执行；本地与远端不同步时，优先 fetch 后手动合并而非硬重置。
