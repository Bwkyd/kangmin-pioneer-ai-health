# 智能体设计改造计划：五视角对抗性评审

- 日期：2026-08-09
- 评审对象：`immutable-mixing-neumann.md`（对话式评估全链路真实化实施计划，今日交付 Web 试用）
- 评审方式：5 个子 agent 并行，各持单一视角（临床规则 / 架构安全 / 数据一致性 / 前端演示效果 / 交付运维）对计划挑刺
- 关联：决定文档 `../product/2026-08-09-评估问卷与规则确认-decision.md`；部署计划 `../plan/006_minimum-customer-trial-and-feedback-plan.md`
- 结论：**计划方向正确，但按当前版本不可直接执行**。P0-1/P0-2（表迁移、灸字误判）为"不改即不可用"硬伤；P0-8/9/10（planBundle 泄露、模型不可用预案、结果卡渲染）是三个必须回填的空洞。修订计划后再实施。

## 分级标准

- **P0 阻塞**：线上不可用 / 判定错误 / 交付失败，必须修
- **P1 高风险**：违背已确认决定 / 演示穿帮 / 明显缺陷，应修
- **P2 一般**：边界问题、连锁影响，可修可缓
- **P3 建议**：打磨与流程项

---

## P0 阻塞（10 项）

1. **新阶段 `screening`/`phase` 撞 `agent_decisions.stage` CHECK 约束**——`database.ts` 0008 迁移 stage CHECK 仅含 6 个旧值（`database.ts:694-698`，PG 同款 `pg-migrations.ts:408-420`），新流水线首轮即写库失败。**本轮必须新增迁移**，计划"只 seed 不迁移"错误。
2. **"点揉，不灸"含"灸"子串被 `planMethodAttributes` 误判 moxibustion=yes**（`sqlite-plan-registry.ts:34`）→ MSAF-01（`rule-package.ts:381-390`）阻断所有肺经伏热患者。修正：seed 时"不灸"注解不落 `method` 字段（放 precautions/steps），或修映射做负向识别。
3. **T5 的 `thirst=no` 与决定①相悖**——决定①目标人群 Q11B 自带"口干咽燥"（decision.md 24 行），T5 排除口渴者 = 寒热错杂大面积漏判。
4. **`口渴+四肢不温+无倦怠` 从寒热错杂变为 no_match**——现有测试断言该组合为 COLD_HEAT_COMPLEX（`clinical-rules.test.ts:216-221`），客户树第 1 步该组合应无条件判肺经伏热；改 T5 后落空，属本轮引入的判定回归，禁止静默落到 no_match。
5. **部署缺线上 seed 灌入**——线上 `agent_plans` 无真实数据，冻结后 plan_safety 查不到方案，结果页方案区块必空。
6. **seed 源资料无 steps/precautions 正文**——`care-plans.md` 仅手法名清单（12-90 行）；管理端 `planContentMissing` 拒绝全空（`agent-admin-service.ts:1030-1044`）；无源正文不得编造（CLAUDE.md 纪律）。修正：seed 砍最小集 + 明确各字段落点。
7. **前端 nextQuestions 选项渲染缺失**——无模型 key 时自由文本路径必降级，评估卡在补问。纯选项路径（message=""）是唯一可行路径，前端须把补问渲染成可点选项。
8. **planBundle 患者侧泄露**——裁剪逻辑（`conversation-service.ts:513-529`）未覆盖 planBundle，candidate 下 `agent exec --json` 可直接拿完整方案，绕过 CLINICAL_FREEZE_BLOCK 与 browse 双门禁（评审 P0-2"三步拼装"防护失效）。修正：planBundle 永不进 patientVerdict，前端只从消息内容渲染。
9. **模型不可用预案缺失**——客户按问卷习惯答"A/选项原文"时确定性解析器三形式全落空（`answer-parser.ts:17-108`）→ 无限重复提问 + 每轮内部术语 notice"智能提取服务暂不可用"（`output-validation.ts:51-52`）穿帮。修正：部署前确认/配置 key，或补问下挂"是/否/不清楚"快捷按钮（不依赖模型），notice 改客户可读文案。
10. **verdict 结果卡渲染是计划最大空洞**——现状是 10px 调试文本（`App.tsx:72-79` 含"命中规则/规则包版本"），且 classified 轮会"模板全文气泡 + verdict 调试卡"双份展示（`App.tsx:92-94`）。修正：前端类型补 phaseCode/audience、新增结果卡渲染、删调试串、独立富卡片样式。

## P1 高风险（13 项）

1. **Q1 三选项→二元映射未定义**——Q1 A/B/C（频繁/偶尔/基本不打）vs 字段提示词"数十个连发"（`rule-package.ts:139`）：选"偶尔"者可能答 no → 误判缓解期（违背决定⑤"B→急性期"）。
2. **缓解期主症<2 项被 APP-01 转介**（`rule-package.ts:133-156`）——已通过确诊题的患者再收"建议明确诊断"，文案穿帮，调体人群被挡。
3. **seed 成人/小儿拆分规则未定义**——"小儿："前缀条目归属、成人/小儿两版清单拆分、"不灸"备注保留均未写明。
4. **删 Q12-14 违背决定⑤字面**（"保留提问，仅作信息收集"）——需 board 显式记录偏离或保留 Q12 采集。
5. **冻结固化 T3/T4 既有漏判**——T3 硬要求 fear_wind=yes（客户树肺气虚寒不依赖 Q6）；T4 用自造字段 cold_intolerance（不对应 Q1-Q14 任何一题）。
6. **决定④（Q6 仅信息收集）与决定①（Q6 作寒象）字面矛盾**——计划静默选择①，需显式标注待客户确认。
7. **`syndrome='ACUTE'` 撞管理端固定证型校验**（`agent-admin-service.ts:933-942` requireSyndrome）→ 急性期方案无法走管理端生命周期，只剩直接 SQL 绕过 arch/003 发布校验。修正：方案管理链显式支持 phase 键。
8. **测试 INSERT 全缺 `applicable_age`**（`clinical-rules.test.ts:451-478`、`browse-cli.e2e.test.ts:64-79`、`config-gates.test.ts:69-82`）→ 按人群过滤后测试全挂；查询语义须明确 NULL 不匹配、禁止宽松降级。
9. **version/status 硬断言破裂**（`clinical-rules.test.ts:65-66`）；建议版本升级 `clinical-rules-v1` 使冻结前后可区分。
10. **缓解期模板含【急性期方案】区块**（页面展示.md:172-176）——planBundle 查询矩阵（何时含 ACUTE）未定义。
11. **部署四件套**：/ready 不会翻 true（encryption/provider 仍 not_configured，验收口径须钉死）；部署前备份（沿用 backups/app-before-* 机制）；旧会话续聊会追问新字段（演示穿帮，用新会话）；ssh 连通性从未验证（今天唯一外部依赖，须提前只读验证）。
12. **planBrowseEnabled 与包状态脱钩**——组合根注入的是 `KANGMIN_PLAN_BROWSE_ENABLED` env（`composition-root.ts:740-742`），无任何代码读包状态；PG 路径未传该选项 → 生产 browse 恒关。修正：`planBrowseEnabled = DRAFT_RULE_PACKAGE.status === "approved"` 派生，与探针同源。
13. **方案包 plan_safety 合并评估语义未定义**——两条方案属性按插入序覆盖、ACUTE 共享方案禁忌带向全部证型；且冻结后历史决策按实时 kernel 状态回溯解封（`conversation-service.ts:474`）。修正：逐条独立评估、任一命中即阻断整包；裁剪依据改决策行自身包状态。

## P2 一般（10 项）

1. 确诊"不确定"若解析为 unknown 会无限补问——应映射为 no→转介。
2. Q9/Q6 三值→二元映射失真（"天气冷时凉" vs "手脚经常冰凉"）；T5 补问缺 fear_wind 会静默漏判。
3. screening 在 safety 前：确诊=no 的紧急患者先收转介而非"立即就医"红线——顺序需论证或调整。
4. seed 幂等（裸 INSERT 重复 PK 冲突）；小儿+寒热错杂无小儿条目 → seed 实为 11 条，该路径无方案需渲染层处理。
5. 决策凭证单列 plan_id 落两条方案中哪条；方案内容无哈希复核（审计链）。
6. 冻结后 browse plan list 向患者暴露全量方案（无证型上下文）。
7. 测试分级验证（typecheck+lint+node 先行，E2E 最后）；演示一律走纯选项路径。
8. 本地 8788 临时库先验 seed 再切线上。
9. 补问格式与问卷逐题不符（标签后缀、2 题合并）——建议逐题一问 + 去技术后缀。
10. 移除 step 0-4 后评估入口空白；首页残留"演示/待审核"文案（App.tsx:1324-1326、1343）；硬编码"今天 14:20"（App.tsx:1366）；"小岐"品牌混搭（App.tsx:1182、1294）。

## P3 建议（4 项）

1. 从 origin/main 开 worktree 开发（工作区有未提交改动，防 git reset 误覆盖教训）。
2. seed 复用 `createPlanIdempotent`（`sqlite-agent-admin-repository.ts:566`）；部署验证补 JS/CSS SHA 核对。
3. SYNDROME_LABELS 改简称对数据层无操作（`agent-admin/domain.ts:31-33` 派生已取逗号前），风险低。
4. seed 视频占位 null 违反 arch/003 发布门禁——board 记录"医学审核后补齐"。

## 各视角总体判定

| 视角 | 判定 |
|---|---|
| 临床规则 | 不能安全执行：T5 `thirst=no` 与决定①相悖 + 判定回归 |
| 架构安全 | 不能安全执行：planBundle 泄露 + stage CHECK 迁移缺失 |
| 数据一致性 | 不可按当前版本执行：CHECK 约束 + 灸字误判 |
| 交付运维 | 可交付但依赖修掉 P0-1/2/3 与作者在场 |
| 前端演示 | 三个空洞未回填则大概率第一步或最后一步穿帮 |

## 第二轮评审结论（2026-08-09 追加，全部闭环进计划 v4）

v2 经五视角二轮评审 + codex 独立评审（命令 `codex exec -m gpt-5.6-sol -c model_reasoning_effort=medium`），关键新发现与处置：

| # | 发现 | 处置（v4） |
|---|---|---|
| 1 | T1/T2×T5 互斥消解不完备（穷举 6 组合双命中，全落寒热错杂人群）→ conflict 死路 | T1/T2 拆双规则（T1a/b、T2a/b），31/32 组合唯一命中 + 1 罕见组合 no_match 兜底 |
| 2 | 按钮载荷 message="" 死循环（answer-parser 空串返回 []） | 按钮传选项值（q1=B）或裸词，严禁空串 |
| 3 | 无 key 时每轮降级 notice（22 条噪音） | 确定性解析命中时跳过 extraction |
| 4 | 确诊"不确定"→no 无机制（通用映射会击穿 SAF-01） | 仅 diagnosed_confirmed 字段白名单特判 |
| 5 | 删 Q2-Q4/Q12-14 违背决定⑤字面与"页面一致"底线（codex） | 作者拍板：多选题保真（原题原选项按钮+选项值映射），Q12-14 保留提问 |
| 6 | 注册表查询未按期别×人群闭环（codex） | findApprovedPlanBundle 双方案查询 |
| 7 | 未确认线上数据库后端就砍 PG（codex） | 部署预检第 1 项必查 KANGMIN_DATABASE_URL |
| 8 | 回滚/清库缺 DB+WAL/SHM 备份与外键顺序（codex） | 部署脚本补：一致性备份 + 子表到父表事务清理 |
| 9 | seed 占位文案会被启用校验放行（codex） | seed 用已确认固定安全文案，拒绝占位词 |
| 10 | SQLite 无法 ALTER CHECK | 表重建迁移，新列一律可空 |

作者拍板 8 项与 AI 决策 A1-A10 见 `../product/2026-08-09-智能体设计-决策记录.md`；定稿计划见 `immutable-mixing-neumann.md` v4。

## 待作者/客户拍板（修订计划前置）

1. **T5 寒热错杂判定**：接受折中（客户树"口渴→肺经伏热"为基准，寒热错杂接"热象+寒象且无口渴无疲倦"），还是按决定①字面（热象+寒象，不管口渴疲倦，冲突靠内核 conflict 兜底）？两者均需医学审核标注。
2. **Q1 期别映射**：新增三值字段收 A/B/C（改动大），还是复用二元字段+映射规则（改动小、需对齐提示词）？
3. **线上模型 key 现状**：演示走纯选项路径（无 key 也行），还是配置 DEEPSEEK_API_KEY 走自由文本？决定前端方案与 notice 文案。
