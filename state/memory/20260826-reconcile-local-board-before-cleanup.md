---
name: 清理前核对主状态与 squash 等价性
description: worktree 收尾前核对主工作区记录、PR 状态和文件树等价，避免状态或独有成果丢失
metadata:
  type: feedback
---

# 清理前核对主状态与 squash 等价性

任务在隔离 worktree 中提交、合并和清理，不代表主工作区的未提交状态已进入远端，也不代表
squash 合并后的源分支已经成为主分支祖先。尤其 `state/board.md` 可能在任务启动前后由主工作区
追加，只核对任务 worktree 会遗漏可接续信息；只运行 `git branch -d` 则会把正常 squash 误判为
“未合并”。

## 收尾核对

1. 使用 `scripts/worktree-audit.sh <task-worktree>` 检查任务 worktree 的状态、独有提交、PR 和登记表。
2. 在主工作区额外执行 `git diff origin/main -- state/board.md`，区分已进入远端的记录与本地独有记录。
3. 独有 board 记录先按时间顺序并入最新主分支并完成交付，再判断 worktree 和分支是否可清理。
4. squash 合并时同时核对 PR 为已合并、目标合并提交存在、源分支工作区无未提交文件，并比较源提交
   与 squash 合并提交的文件树。只有差异为空且远端成果已进入目标分支，才可在删除 worktree 后
   强制删除因祖先关系不同而无法 `git branch -d` 的本地源分支。
5. 清理后再次 `fetch --prune`，核对只剩预期 worktree、分支与作者原件；旧 release 和数据库备份
   属于回滚材料，不随任务临时物一起删除。
6. 不借状态收尾顺带提交作者原件或无关改动；未获授权不删除 worktree 或分支。
