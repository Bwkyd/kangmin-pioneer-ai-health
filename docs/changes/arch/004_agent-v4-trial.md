# 004 智能体设计 v4：对话式评估全链路真实化（客户 Web 试用交付）

- 日期：2026-08-09
- 依据：`docs/product/2026-08-09-智能体设计-决策记录.md`（作者拍板 8 项 + AI 决策 A1-A10）；决策真相源 `docs/product/2026-08-09-评估问卷与规则确认-decision.md`；计划 v4（评审闭环后定稿）
- 交付：客户 Web 试用链接（tag `customer-trial-2026-08-09`，部署 `16b3888`）

## 变更内容

1. **规则包冻结**：`clinical-rules-v1`（status=approved）。证型 v3 七规则（T1a/T1b/T2a/T2b/T3/T4/T5），32 组合穷举 31 唯一命中 + 1 no_match（怕热单独）兜底；删 SAF-07（儿童可用）、删 APP-01（确诊题承担适用范围门禁）。
2. **流水线扩展**：`safety → screening → phase → applicability → severity → syndrome → plan_safety`。screening 含确诊门禁（unknown 白名单特判 A4）与人群派生；phase 由 Q1 选项值派生期别。
3. **多选题保真**：前端渲染客户问卷原题原选项按钮，传稳定选项值（q1=B），服务端确定性映射（`option-mapping.ts`，A5）；模型提取为可选增强路径。
4. **双方案注册表**：`findApprovedPlanBundle({syndromeCode, phaseCode, audience})` 按期别×人群精确匹配急性期+调体两方案，逐条独立 plan_safety 评估（任一命中阻断整包）。
5. **输出**：急性期/缓解期两套模板按《页面展示》纯文本化；planBundle 永不进患者侧（防三步拼装侧信道）；证型展示名改简称。
6. **迁移**：SQLite 0011（agent_decisions 表重建：stage CHECK 加 screening/phase + 3 新列）、0012（agent_plans 加 phase_code/audience）；PG 0004 对齐（CI 门禁暴露后补）。管理端 ACUTE 特判 + phaseCode/audience 全链路落库。
7. **seed**：11 条客户确认方案（寒热错杂无小儿）走 createPlan+enablePlan 受校验路径，手法名直译步骤，禁占位文案。
8. **前端**：问卷原题选项卡、结果卡富渲染、移除演示残留、文案对齐《页面展示》。

## 架构影响

- 规则包从 candidate 冻结为 approved 后，患者正式输出路径放开（双门禁：包状态 + plan 启用）。
- 决策凭证新增 phase_code/audience/rule_package_status 列；历史决策裁剪按决策行自身包状态（不随当前包状态解封）。
- 期别/人群成为判定输入，所有消费方（内核/渲染/管理端/注册表）同步扩展。

## 验证

- node 测试 245 + Web 浏览器 E2E 全 PASS；基准测试 12/12（七规则+期别+人群+边界）。
- 线上冒烟 19 轮全链路 + 真实浏览器完整评估 + 前端资源 SHA 核对。
- 评审收敛两轮（三视角分身 + codex）P0 无遗留。

## 回退

服务器 `data/backups/kangmin-mvp-20260809-125328-before-16b3888.sqlite` + releases 旧软链（cc79ac5）。

## 待客户反馈

证型 v3 与儿童可用（供医学审核）、Q12-14 信息收集路径、浏览门禁口径、偏离清单 7 条。
