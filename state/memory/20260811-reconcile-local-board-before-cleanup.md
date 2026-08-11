---
name: 清理前合并本地主状态
description: 隔离 worktree 收尾前核对主工作区未提交状态，避免状态板记录留在本地
metadata:
  type: feedback
---

任务在隔离 worktree 中提交、合并和清理，并不代表主工作区的未提交状态已经进入远端。尤其 `state/board.md` 可能在任务启动前后由主工作区追加历史记录；只核对任务 worktree 干净会遗漏这些可接续信息。

**How to apply:** 合并后、删除任务 worktree 前后均比较 `git diff origin/main -- state/board.md`，区分“已由远端覆盖的状态”和“仅存在本地的独有记录”。独有记录应在新的隔离 worktree 中按时间顺序并入最新 `origin/main`，通过 PR 合并后再处理主工作区同步；`AGENTS.md`、`CLAUDE.md` 等作者改动继续原样保留，不借状态收尾顺带提交。
