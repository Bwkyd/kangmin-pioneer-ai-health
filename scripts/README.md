# scripts — 确定性脚本

> 第三组“脚本与扩展”的硬约束层：技能编排软流程，脚本机械判对错。

## 收录判据

能稳定用规则判断命名、结构、格式、链接、清单或环境是否正确的检查写成脚本；需要判断
方案质量或业务取舍的工作留给人、技能或有界实验。

## 当前入口

| 脚本 | 职责 |
| --- | --- |
| `structure-lint.py` | 检查项目目录、命名、导航和双入口同步 |
| `check-manifests.py` | 校验 `plugin.json` 与 `42plugin.json` |
| `check-tools.sh` | 只读检查本机工具，不自动安装 |
| `install-git-hooks.sh` | 安装项目 Git 防误推钩子 |
| `worktree-create.sh` | 从最新远端基线创建任务 worktree |
| `worktree-audit.sh` | 只读检查 worktree 是否满足清理条件 |
| `configure-branch-protection.sh` | 按显式授权配置远端分支保护 |

## 约定

- 一个脚本只做一件事，重复执行得到相同判断。
- 检查脚本只报告问题，不擅自修改；修复动作另设入口并由人决定是否执行。
- 第二次手工重复同一机械检查时，优先把它固化为脚本。
