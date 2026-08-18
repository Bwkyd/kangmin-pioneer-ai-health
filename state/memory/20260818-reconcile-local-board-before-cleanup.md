---
name: 清理前合并本地主状态
description: 隔离 worktree 收尾前核对主工作区的独有 board 记录，避免状态丢失
metadata:
  type: feedback
---

# 清理前合并本地主状态

任务在隔离 worktree 中提交、合并和清理，不代表主工作区的未提交状态已进入远端。
尤其 `state/board.md` 可能在任务启动前后由主工作区追加，只核对任务 worktree 会遗漏
这些可接续信息。

## 收尾核对

1. 使用 `scripts/worktree-audit.sh <task-worktree>` 检查任务 worktree 的状态、独有提交、PR 和登记表。
2. 在主工作区额外执行 `git diff origin/main -- state/board.md`，区分已进入远端的记录与本地独有记录。
3. 独有 board 记录先按时间顺序并入最新主分支并完成交付，再判断 worktree 和分支是否可清理。
4. 不借状态收尾顺带提交作者原件或无关改动；未获授权不删除 worktree 或分支。
