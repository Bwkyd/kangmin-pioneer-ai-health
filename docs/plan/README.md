# 计划文档

本目录保存目标设计、交付计划和实施方案。详细计划写在对应文档、Issue 或任务
上下文；`state/board.md` 只在每轮摘要中记录实际变化、验证、遗留、待办及相关链接。
标记“已落地”的旧方案只作历史档案，不能证明今天仍存在相同问题。

| 编号 | 日期 | 状态 | 文档 |
| --- | --- | --- | --- |
| 001 | 2026-07-31 | 设计基线 | [患者端 CLI 设计](001_kangmin-patient-cli-design.md) |
| 002 | 2026-07-31 | 设计基线 | [管理端 CLI 设计](002_kangmin-admin-cli-design.md) |
| 003 | 2026-08-05 | 指定基线计划 | [最小客户试用版与反馈计划](003_minimum-customer-trial-and-feedback-plan.md) |
| 004 | 2026-08-02 | 已落地档案 | [R1 配置开关域](004_fix-r1-config-gates.md) |
| 005 | 2026-08-03 | 已落地档案 | [R2 内容媒体域](005_fix-r2-content-media.md) |
| 006 | 2026-08-04 | 已落地档案 | [R3 Agent 会话域](006_fix-r3-agent-session.md) |
| 007 | 2026-08-09 | 已合并交付，客户已收到反馈 | [修正评估页面与有序六步证型决策树](007_fix-ordered-syndrome-decision-tree.md) |
| 008 | 2026-08-11 | Web 已部署，正式切换待资源 | [腾讯云正式环境切换方案](008_tencent-cloud-production-cutover.md) |
| 009 | 2026-08-17 | 实现候选完成，未提交/部署 | [Web 试用版非智能体报价闭环](009_non-agent-quotation-web-closure.md) |
| 010 | 2026-08-17 | 已合并，待外部资源联调；未部署 | [原生微信小程序非智能体薄壳](010_native-miniprogram-non-agent-shell.md) |
下一份计划编号从 `011` 开始。

新增计划必须写明目标、非目标、范围、依赖、风险、验收方式、当前状态和收尾证据。

## 待作者拍板的研究取舍

- 2026-08-14 · 客户的诊一诊需求是什么，以及下一件最该做的工作是什么 → 取舍卡见 `docs/research/003_zhenyiwen-customer-needs/decision.md`
- 2026-08-17 · 通用鼻炎科普问答应采用哪种知识边界与检索降级策略 → 客户 20 号返回后拍板，取舍卡见 `docs/research/004_general-rhinitis-qa-boundary/decision.md`
