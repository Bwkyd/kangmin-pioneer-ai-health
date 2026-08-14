# .codex — Codex 项目配置

本项目主要使用 Codex。仓库级持久指令以根目录 `AGENTS.md` 为主入口；`CLAUDE.md` 仅为
Claude Code 兼容副本，并由结构检查保证除首行外一致。

## 当前文件

| 文件 | 职责 |
| --- | --- |
| `config.toml` | 设置 Codex 项目指令回退名与最大加载容量 |

Codex 只在仓库被信任时加载项目 `.codex/config.toml`。不要在这里写模型密钥、个人凭据或
机器专属绝对路径；个人默认值继续留在用户级 `~/.codex/config.toml`。

项目可复用工作流按 Codex 官方发现规则放在 `.agents/skills/`，当前通过符号链接指向根目录
`skills/` 中的唯一正本，避免为 Codex 和 Claude 分别维护两份技能内容。
