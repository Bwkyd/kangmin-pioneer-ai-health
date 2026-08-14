# kangmin 演化记录（给人类）

> 本文件回答三问：**变了什么、为什么变、对你意味着什么**。每个里程碑一条，倒序追加。
> 想看更细：AI 工作流水见 `state/board.md`，完整历史见 git log。规则见 `meta/kangmin_directory-protocol.md` 第二节。


## 2026-08-14 · 六组骨架按初始化方法归位

**变了什么**：项目以 `aias-meta-init` 为基线补齐插件清单、确定性检查、动态评审和
notes 边界说明；进一步把 Codex 定为主要 Agent，以 `AGENTS.md` 为主规约，补齐 `.codex`
项目设置和 `.agents/skills` 官方技能发现入口；README、兼容规约、技能与规格索引同步归位。

**为什么变**：原有 `.42cog/` 已完成项目化，但脚本与扩展骨架不全，多个入口也没有完整
承接初始化方法，换会话后仍需靠隐含上下文补足工作方式。

**对你意味着什么**：从 README 看项目，Codex 从 AGENTS 开工、Claude 从同步兼容副本开工，
从 board 接续；运行
`python3 scripts/check-manifests.py` 与 `python3 scripts/structure-lint.py .` 即可机械确认骨架。
