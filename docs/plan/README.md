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
| 009 | 2026-08-17 | 已合并并部署 Web 试用环境；管理工作台 PR #222 已收口 | [Web 试用版非智能体报价闭环](009_non-agent-quotation-web-closure.md) |
| 010 | 2026-08-17 | 已合并，CLI 上传接口验证通过；待真机/客户验收 | [原生微信小程序非智能体薄壳](010_native-miniprogram-non-agent-shell.md) |
| 011 | 2026-08-19 | 实施中；冻结 Web 患者端并迁移至小程序 | [Web 患者端迁移至微信小程序](011_web-patient-miniprogram-migration.md) |
| 012 | 2026-08-22 | 实验 016 已停止；下一变量为概念证据与操作证据隔离 | [患者智能体评测体系设计](012_patient-agent-evaluation-system.md) |
下一份计划编号从 `013` 开始。

新增计划必须写明目标、非目标、范围、依赖、风险、验收方式、当前状态和收尾证据。

## 待作者拍板的研究取舍

- 2026-08-14 · 客户的诊一诊需求是什么，以及下一件最该做的工作是什么 → 取舍卡见 `docs/research/003_zhenyiwen-customer-needs/decision.md`
- 2026-08-17 · 通用鼻炎科普问答应采用哪种知识边界与检索降级策略 → 客户 20 号返回后拍板，取舍卡见 `docs/research/004_general-rhinitis-qa-boundary/decision.md`
- 2026-08-18 · 如何把现有管理后台从演示型页面收敛为报价内可运营后台，并先做哪一件事 → 取舍卡见 `docs/research/005_admin-operable-backoffice/decision.md`
- 2026-08-21 · 模型会不会乱说，以及后端医学校验是否必要 → 取舍卡见 `docs/research/008_model-safety-boundary/decision.md`
- 2026-08-21 · 既能广泛回答又不乱说的医疗 Agent 架构 → 取舍卡见 `docs/research/009_answer-first-medical-agent/decision.md`
- 2026-08-21 · 用评测驱动的上下文工程降低患者 Agent 无依据补全 → 取舍卡见 `docs/research/010_eval-driven-context-engineering/decision.md`
- 2026-08-22 · 修正版患者智能体实验是否同时加入上下文与模型变量 → 取舍卡见 `docs/research/011_context-model-factorial/decision.md`
- 2026-08-22 · 医疗 RAG 命中失败、模型越界与答案发布门的近期业界实践 → 取舍卡见 `docs/research/013_medical-rag-answer-release/decision.md`
- 2026-08-23 · 患者智能体医学输出如何拦截：规则、分类小模型还是大模型护栏 → 取舍卡见 `docs/research/014_medical-safety-guardrail-selection/decision.md`

## 已拍板实施入口

- 2026-08-22 · 不训练、不切换生产模型，按 #236 → #237 → #238 实施报价内语义 RAG
  纵向切片 → 决策见 `docs/product/2026-08-22-agent-scope-decision.md`
