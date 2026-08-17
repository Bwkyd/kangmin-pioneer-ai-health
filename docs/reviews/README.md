# 评审文档

本目录保存指定时间与代码基线下的评审结论，不是当前项目状态页。

| 编号 | 日期 | 角色 | 文档 |
| --- | --- | --- | --- |
| 001 | 2026-08-02 | 初始报告 | [CLI 开发完成度调研](001_cli-dev-status-review.md) |
| 002 | 2026-08-02 | 最终复核入口 | [CLI 完成度对抗评审与复核](002_cli-dev-status-adversarial-review.md) |
| 003 | 2026-08-02 | 原始审计材料 | [Codex 对抗评审原始输出](003_codex-adversarial-raw.md) |
| 004 | 2026-08-09 | 计划对抗评审 | [智能体设计改造计划五视角评审](004_agent-assessment-adversarial-review.md) |
| 005 | 2026-08-17 | 三视角交付复核 | [Web 试用版非智能体报价闭环复核](005_non-agent-quotation-web-closure-review.md) |
| 006 | 2026-08-17 | 三视角交付复核 | [知识库内嵌编辑交付复核](006_knowledge-inline-edit-review.md) |
| 007 | 2026-08-17 | 三视角交付复核 | [原生微信小程序非智能体薄壳复核](007_native-miniprogram-non-agent-shell-review.md) |

下一份评审编号从 `008` 开始。

阅读顺序为 002 → 001 → 003。003 保留原始输出，因此其中旧工作区的绝对路径和
当时行号不做重写；需要当前证据时回到现有代码重新定位。

由这批评审形成的 R1–R3 方案见 [`../plan/`](../plan/) 的 004–006。
