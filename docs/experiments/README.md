# 实验文档

本目录保存有界实验的记录。`AGENTS.md` 的开工协议要求：结构或方案存在分叉时，先做
有界实验并记录成本、证据与限制；实验记录在这里，结论成熟后进入 `plan/` 或直接
落地，历史实验不构成当前事实。

| 编号 | 日期 | 状态 | 文档 |
| --- | --- | --- | --- |
| 001 | 2026-08-13 | 已完成（6/6 断言通过，发现 F1–F3） | [诊一诊约束对话可行性实验](001_zhenyiwen-constrained-dialogue.md) |
| 002 | 2026-08-21 | 已完成（方向部分通过，H3 安全门禁未通过） | [通用 Agent 工作手册与只读知识搜索](002_general-agent-workbook-smoke.md) |
| 003 | 2026-08-21 | 已完成（语义召回通过，安全与上线门禁未通过） | [字面、语义与混合知识检索对比](003_knowledge-retrieval-ablation.md) |
| 004 | 2026-08-21 | 已完成（模型直出未通过，离线门禁回放通过） | [模型直出与确定性医学门禁回放](004_model-safety-boundary.md) |
| 005 | 2026-08-21 | 已完成（同模型审阅未通过，自适应独立审阅方向待验证） | [回答优先、模型审阅与定向修复](005_answer-first-verify-repair.md) |
| 006 | 2026-08-21 | 已完成（纯提示词保持回答性，高风险行为门禁未通过） | [系统提示词约束消融](006_system-prompt-ablation.md) |
| 007 | 2026-08-21 | 已完成并复核（专业原文 + 警告卡未降低预设违规） | [患者 Agent 专业原文与警告卡消融](007_context-engineering-ablation.md) |
| 008 | 2026-08-22 | 240 条全矩阵完成；患者知识选择有效，但三个模型均未通过高风险人工校准 | [患者知识选择 × 候选模型析因](008_context-model-factorial.md) |
| 009 | 2026-08-22 | V4 Pro 授权题 5/5，但高风险仍失败 4/10；只换模型未通过 | [DeepSeek V4 Pro 单变量替换](009_model-replacement-screen.md) |
| 010 | 2026-08-22 | 已完成（真实向量回放 Hit@3 10/10，放行 #236） | [语义检索生产实现冒烟与有界实验](010_semantic-retrieval-production-smoke.md) |
| 011 | 2026-08-22 | 已完成（12/12 安全动作集，10/12 首选成本路径） | [自然鼻健康问法与单次工具决策](011_natural-question-tool-routing.md) |
| 012 | 2026-08-22 | 已完成（20/20 正反例通过，放行 #238） | [医学硬事实发布条件](012_medical-hard-fact-publication-gate.md) |
| 013 | 2026-08-22 | 已完成（真实全链路 Hit@3 17/17，高风险 5/5） | [福建手册知识导入](013_manual-knowledge-import.md) |
| 014 | 2026-08-22 | 已完成（10 题单次 L0 0/10，定位发布门降级与急症路由缺口） | [患者智能体 10 题单次真实基线](014_patient-agent-evaluation-baseline.md) |
| 015 | 2026-08-22 | 首阶段已完成（旧严格契约过严，患者可接受率待重新标定） | [回答局部修复的安全、正确、通俗与速度实验](015_answer-repair-readability-latency.md) |
| 016 | 2026-08-22 | 已执行并停止（思考无收益；发现概念检索片段混入操作内容） | [风险分层知识回答与思考模式实验](016_risk-tiered-knowledge-answer-thinking.md) |
| 017 | 2026-08-23 | 已完成（分流 15/15、最小门 20/20、真实模型 18/18） | [每轮系统提示与最小危险内容拦截实验](017_system-prompt-minimal-safety-gate.md) |
| 018 | 2026-08-23 | 已停止（薄门误拦且对已知题过拟合，不接运行时） | [旧高风险回答重评与无模型薄兜底](018_high-risk-regrade-thin-guard.md) |
| 019 | 2026-08-23 | 已完成（C/D 13/15；孕期禁忌和未知喷剂仍越界） | [系统提示词宽松安全对照](019_system-prompt-balanced-comparison.md) |
| 020 | 2026-08-23 | 已完成（4/4 冒烟通过，放行统一回答路径实现） | [统一患者回答路径冒烟实验](020_unified-patient-answer-smoke.md) |
| 021 | 2026-08-23 | 两轮已完成（首页样本通过代码/编译/交互门禁，全站仍待逐页推进） | [Web 与小程序首页同构冒烟实验](021_web-miniprogram-home-parity-smoke.md) |
| 022 | 2026-08-26 | 已完成（H1–H3 通过，放行 #276 实现） | [知识生命周期原子更新与单资料测试](022_knowledge-lifecycle-atomic-update.md) |
| 023 | 2026-08-26 | 已完成（H1–H3 通过，放行 #279 关闭） | [文件引用去向与删除保护](023_file-reference-and-delete-guard.md) |
| 024 | 2026-08-26 | 已完成（H1–H3 通过，放行 #281 交付） | [管理后台工作台首屏冒烟实验](024_admin-workbench-first-screen-smoke.md) |
| 025 | 2026-08-26 | 已完成（H1–H4 通过，放行 #283 交付） | [学一学人群分类与小程序页面冒烟实验](025_learning-audience-classification-smoke.md) |
| 026 | 2026-08-27 | 已停止（行为保持，但导航成本 13.45→13.46） | [浏览测试按行为轴拆分冒烟](026_browse-test-split-smoke.md) |
| 027 | 2026-08-27 | 进行中（模型端口测试两域拆分） | [模型端口测试两域拆分](027_model_ports_test_split.md) |
| 028 | 2026-08-27 | 已完成（2/2 内容行为通过，零命中反证 exit 1） | [内容供给闭环快速冒烟入口](028_content-smoke-entry.md) |
| 029 | 2026-08-27 | 已完成（症状 3/3；零命中与断言反证 exit 1） | [症状管理快速冒烟入口](029_record-smoke-entry.md) |
| 030 | 2026-08-27 | 进行中（基础壳入口待完成正反验证） | [基础壳与环境门禁快速冒烟入口](030_shell-smoke-entry.md) |
| 031 | 2026-08-27 | 通过可行性门（行为不退化，导航成本继续观察） | [小程序 workspace 最小分形样本](031_miniprogram-workspace-fractal-smoke.md) |
| 032 | 2026-08-27 | 已通过（后台独立，旧患者 Web 退役） | [管理后台独立与患者 Web 退役](032_admin-app-patient-web-retirement.md) |
| 033 | 2026-08-27 | 已完成（核心包四组边界） | [核心包最小分形边界](033_core-package-fractal-boundary.md) |
| 034 | 2026-08-27 | 已完成（数据库双后端同构） | [数据库包双后端](034_database-package-dual-backend.md) |
| 035 | 2026-08-27 | 已完成（外部适配器失败关闭） | [集成包失败关闭](035_integrations-package-fail-closed.md) |
| 036 | 2026-08-27 | 已完成（runtime、CLI 与 API 收口） | [runtime、CLI 与 API 入口](036_runtime-cli-api-entrypoints.md) |
| 037 | 2026-08-27 | 已完成（最终 workspace 交付链） | [workspace 交付链](037_workspace-delivery-chain.md) |
| 038 | 2026-08-27 | 已完成，PR CI 通过 | [四条业务链技术预验收](038_business-preacceptance.md) |
| 039 | 2026-08-27 | 已完成（历史组合实验；后续由分组快速入口取代） | [四组功能冒烟与有界反证](039_four-group-smoke-bounded-validation.md) |
| 040 | 2026-08-28 | 已完成（4 项源码级检查稳定拦截；真实几何保留 DevTools 手工门） | [小程序 E2E 缺陷回归检查点](040_miniprogram-e2e-regression-checks.md) |
| 041 | 2026-08-28 | 已完成（仓内缺陷可复现，事务边界需先改造；允许进入修复） | [管理后台缺陷修复可行性与发车门](041_admin-defect-fixability-smoke.md) |

下一份实验编号从 `042` 开始。

新增实验必须写明：状态、日期、事实或代码基线、假设与变量、证据来源、成本与耗时、
验证方式和已知限制；结论与推断分开，推断不得写成当前事实。
