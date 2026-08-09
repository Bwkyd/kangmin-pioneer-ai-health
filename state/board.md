# kangmin · 项目状态板（唯一真相源 · 跨会话可接续）

> 开工先读 `AGENTS.md` + 本文件 + `state/memory/MEMORY.md`；目录语义见 `meta/kangmin_directory-protocol.md`。
> 轮规则：每轮有效项目工作必更新本文件（倒序追加，带日期与 commit hash；git 初始化前省略 hash）。

> ## ✅ 客户原始页面与前置规则 v3 已合并交付（2026-08-09 第二十七轮 · 合并 `c621704`，线上 `e87151d`）
> 客户复测确认线上仍偏离指定资料：页面错误插入安全、确诊、年龄、鉴别和严重度题；旧规则会话点击答案后持续产生“发送失败/不清楚”。本轮已明确职责并落实：`vault/truth/product/assessment-page-content.md` 唯一控制 Q1–Q14 题面、选项、顺序和结果表达；`vault/truth/clinical/assessment-rules.md` 与六步树唯一控制 Q1–Q11 证型、独立二次确认、Q12–Q14 及期别组合。生产规则包升级为 `clinical-rules-v3`，前后端共用 `assessment-questionnaire.ts`，不再自行插题或复制题库。
> 旧规则活动会话首次被读/续答即原子转为 `abandoned`，页面锁定并只提示一次新建评估；选项由服务端成功后才加入消息，失败答案不再污染历史。浏览器 E2E 直接篡改测试会话规则版本复现客户截图，验证旧会话锁定、无失败气泡，再新建会话完整走 Q1–Q14 → Q8/Q10 二次确认 → 寒热错杂 → 缓解期并刷新恢复。
> 验证与部署：`npm run check` 全绿（333 tests：257 pass、76 项因未配置 PG/S3 跳过、0 fail），包含真实浏览器 E2E；9/9 CLI benchmark 与完整 smoke 通过。提交 `e87151d` 已部署试用环境；PR #188 已 squash 合并为 `c621704`，合并代码树与线上业务代码一致，无需重复部署。服务器独立 8788 临时库预检确认 v3 首题为 Q1；停服后将生产 SQLite 备份至 `/srv/kangmin-cli/data/backups/kangmin-mvp-20260809-223926-before-e87151d/`，原子切换 `/srv/kangmin-cli/app` 至完整 SHA release，旧版 `eba184f` 保留可回滚。公网 HTTP E2E 完整走通 Q1–Q14、两个二次确认、寒热错杂与缓解期；线上 index/患者 JS/CSS 与本地构建 SHA-256 一致。服务 active、`NRestarts=0`；`/ready` 仍仅有部署前既有的 encryption/environment-provider 两项 `not_configured`，数据库、对象存储和规则包均为 ok。作者已将结果反馈客户，本任务完成。限制：客户页面没有年龄题，试用页面继续按成人方案；儿童分流必须等客户补充页面题目与口径，不能自行加题。

> ## ✅ 六步树修复已提交并部署客户试用环境（2026-08-09 第二十六轮 · 部署 `eba184f`，PR #188）
> 修复已拆为 `b50b964`（受约束问诊调研）与 `eba184f`（有序六步树、患者答案中文化、方案方法展示、刷新滚动恢复），推送分支 `agent/fix-six-step-tree` 并创建 draft PR #188：`https://github.com/Bwkyd/kangmin-pioneer-ai-health/pull/188`。未合并 PR，客户可先按试用环境实测。
> 部署前新 release 在 8788 + 临时 SQLite 完成生产等价预检；停服后将生产 SQLite 备份至 `/srv/kangmin-cli/data/backups/kangmin-mvp-20260809-215946-before-b1ad92a/`，原子切换 `/srv/kangmin-cli/app` 到 `/srv/kangmin-cli/releases/eba184f750a87abbbd152c97a7478eb4a582ecfa`，旧 release 保留可回滚。`kangmin-cli` 为 active/running、`NRestarts=0`、部署后 warning/error 日志为空；`/live` 为 ok，`/ready` 的数据库/对象存储/规则包均为 ok，两项 local 环境既有 not_configured 与旧版一致。
> 线上公网 E2E 从 `https://49.232.26.48` 完整走通：安全六问全否→已确诊→成人→Q1B→鉴别/严重度全否→Q10B→Q8C→Q6B→Q9B，严格逐节点进入并判定肺气虚寒；结果页含两组“方法（请选择其中一项）”及 7 个逐方法视频区，不含“手法：”“步骤：”或 `pregnancy=no`、`diagnosed_confirmed=yes`、`qN=X` 协议载荷。刷新回首页再进入问助手后结果恢复且滚动到底。公网 index/患者 JS/CSS 与本地构建 SHA-256 三项一致，旧库备份存在且大小正常。

> ## ✅ 六步树移动端 E2E 复核并修复历史定位（2026-08-09 第二十五轮 · 未提交未部署，基线 `50df413`）
> 再次运行完整浏览器 E2E 通过，并用 390×844 移动视口手工走通 Q10B → Q8C → Q6B → Q9B：结果为肺气虚寒；结果卡无“步骤/手法”旧标签，无 `pregnancy=no`、`qN=X` 等内部载荷，7 个方法均各自带操作视频区域；刷新后证型、方案和患者可读历史均可恢复，浏览器控制台无 warning/error。
> 手工复核发现并修复一项自动测试原先未覆盖的真实问题：刷新回首页后再进入问助手，历史消息虽已恢复，但因滚动 effect 只监听 messages，聊天区停在首轮安全题。现滚动逻辑同时监听 chat tab，进入问助手即定位到最新结果；浏览器 E2E 新增“刷新→进入问助手→聊天区到达底部”断言。修复后手工读取 `.chat` 为 `remaining=-0.5px`（浮点舍入，等价底部），移动截图确认最新结果可见。
> 验证：`npm run check` 全绿并包含新增浏览器回归（330 tests：254 pass、76 项因未配置 PG/S3 跳过、0 fail）；结构与 diff 检查在本轮收尾执行。当前仍未 commit、PR 或部署，线上不含本轮修复。

> ## ✅ 有序六步证型决策树完成本地修复（2026-08-09 第二十四轮 · 未提交未部署，基线 `50df413`）
> 证型主判定已由 v3 扁平并行规则替换为唯一的 `clinical-rules-v2` 有序状态机：严格执行 step1_q10 → step2_q8 → step3_q6 → step4_q9 → step5_q8_confirm → step6_q10_confirm，命中叶子立即终止。六个节点分别保存原始 A/B/C，首次与二次 Q8/Q10 不再互相覆盖；非法布尔、非 A–C 和错序载荷 fail-closed，Q1/Q2/Q5/Q7/Q11 等辅助事实不能覆盖叶子。旧规则包的未完成会话返回 `protocol_incompatible` 并提示新建评估。
> 数据层复核确认 SQLite、PostgreSQL 现有主键均为 `(session_id, field_code)`，直接以节点身份作 field_code 即可独立留痕，无须重建表。已用 SQLite 真实仓储验证六个节点答案；PostgreSQL 增补同题首次/二次确认契约，因本机未配置 `KANGMIN_TEST_DATABASE_URL` 按惯例跳过真实 PG 集成，未虚报通过。CLI、HTTP、Web 继续复用同一应用服务；浏览器真实路径 Q10B → Q8C → Q6B → Q9B 已正确收口为肺气虚寒。
> 验证：111 条根到叶 A/B/C 路径逐前缀穷举通过；12/12 真实 CLI benchmark 通过；完整评估 smoke 通过；`npm run check` 全绿（330 tests：254 pass、76 项因未配置 PG/S3 跳过、0 fail）并包含浏览器 E2E；`python3 scripts/structure-lint.py .`、`git diff --check` 均通过。计划 `docs/plan/014_fix-ordered-syndrome-decision-tree.md` 已回写实现证据。当前只完成本地代码与文档修复，尚未 commit、PR、部署、清理线上旧会话或改变线上规则版本。

> ## ✅ 六步证型树规则与实施文档落地（2026-08-09 第二十三轮 · 文档完成，业务待实施，基线 `50df413`）
> 客户最新澄清已完成分层落档：来源整理为 `vault/raw/clinical/syndrome-six-step-decision-tree.md`，当前开发与验收规范为 `vault/truth/clinical/syndrome-six-step-decision-tree.md`；原 `assessment-rules.md` 只保留未被替代的通用、安全和期别规则。证型规范明确六个独立节点、A/B/C 跳转、命中叶子立即结束、Q8/Q10 二次确认独立存储，以及 Q1/Q2/Q5/Q7/Q11 仅作辅助印证。
> 两份产品决策记录已回写客户纠正：旧“Q11B + 寒象”和 v3 七规则标记为历史失效，不再作为实现依据；本次确认没有被扩大到年龄、确诊门禁、期别和安全规则。实施计划已登记 `docs/plan/014_fix-ordered-syndrome-decision-tree.md`，包含节点化数据模型、SQLite/PG 同步迁移、CLI/HTTP/Web 共用状态机、旧会话隔离、111 条根到叶路径穷举及关键错判回归。
> 当前状态：规则、约束、参考资料和验收标准已落实到长期文档；尚未修改证型业务代码、数据库或线上环境，必须按 014 计划完成测试后方可部署。验证：`python3 scripts/structure-lint.py .` 与 `git diff --check` 通过，文档编号和 truth 来源链已纳入结构检查。

> ## 📋 六步证型树修改目标与验收口径（2026-08-09 第二十二轮 · 方案确认中，未改业务代码）
> 本次范围限定为纠正“证型主决策树”：安全筛查→确诊门禁→成人/儿童分流保持；进入证型后严格执行 step1_q10→step2_q8→step3_q6→step4_q9→step5_q8_confirm→step6_q10_confirm，有叶节点立即结束。首次 Q8/Q10 与二次确认分别存储，A/B/C 不再压成布尔值；Q1/Q2/Q5/Q7/Q11 只作辅助印证，不覆盖主树结果。现有急性/缓解期算法不在本次擅自改写，待其单独口径确认。
> 参考优先级：客户本轮明确的六步树（证型主判定）> `vault/raw/clinical/前置规则.md` 对应六步原文；`vault/raw/product/页面展示.md` 负责题面/选项/结果样式；`vault/raw/clinical/急性期方案、调体方案（缓解期方案）.md` 只负责叶节点后的可选方法；现有 v3 七规则、作者/AI 代选记录和自证 benchmark 不得反向覆盖客户规则。DeepSeek 只可做自然语言到受控选项候选的提取，不能决定节点跳转或证型。
> 验收底线：穷举 111 条根到叶选项路径，逐条断言题序、跳转、未进入节点不出现、二次确认独立留痕、叶节点立即终止及五证型结果；重点回归 Q10B 不早判肺热、Q8B 不早判脾虚、Q9B/C 必为肺气虚寒、Q10A 首步立即肺经伏热。CLI/HTTP/Web 同一状态机；刷新/历史恢复不改变节点和中文答案；unknown fail-closed；SQLite/PG 迁移同步；旧规则会话不混续；全量 `npm run check`、结构检查、浏览器 E2E 通过后方可部署。类别占比只监测，不作硬编码配额。

> ## 🧭 客户澄清六步树为有序二次确认节点（2026-08-09 第二十一轮 · 仅澄清，未改业务代码）
> 客户确认 1–6 是严格有序的决策步骤：上一步判定后才进入下一步，Q8 第 5 步与 Q10 第 6 步是独立的“二次确认”节点，而不是复用首次答案。第二十轮关于“同轮答案不变则后两分支不可达”的判断据此撤回；材料不是在表达一个扁平事实集合，而是在表达带节点身份和终止条件的状态机。
> 当前实现的结构性错误进一步明确：`option-mapping.ts` 将同名题压成单一布尔字段，`agent_confirmed_answers` 又按 field_code 覆盖，无法同时保存首次回答和二次确认；`rule-package.ts` 用并行 T1–T5 条件匹配替代逐节点跳转，因而既丢失先后顺序，也无法表达“命中即结束”。Q9B 被合并为 limbs_not_warm=yes，线上遂把大量“天气冷时会凉”误判为肾阳不足。客户提到临床肾阳不足约占 10%，该比例只作异常监测证据，不作为硬编码诊断配额。
> 正确修复方向：为 step1_q10、step2_q8、step3_q6、step4_q9、step5_q8_confirm、step6_q10_confirm 建立独立节点/答案身份；严格按 A/B/C 跳转；Q1/Q2/Q5/Q7/Q11 仅作辅助印证，不覆盖主树叶节点。对应可复用经验已登记 `state/memory/20260809-ordered-tree-node-identity.md`。本轮未修改规则、数据库、测试或线上部署。

> ## 🔍 客户决策树错判 E2E 复核（2026-08-09 第二十轮 · 仅诊断，未改业务代码）
> 文件职责确认：`vault/raw/product/页面展示.md` 只定义 Q1–Q14 题面及急性/缓解结果页版式；`vault/raw/clinical/急性期方案、调体方案（缓解期方案）.md` 只定义证型对应的可选方法；证型六步树实际来源是 `vault/raw/clinical/前置规则.md`，实现落在 `option-mapping.ts` + `rule-package.ts`。
> 根因已实证：选项映射把 Q8/Q9/Q10 的 B 分别当作 fatigue/limbs_not_warm/thirst=yes，但客户六步树明确三题均为 B/C 同分支；Q6B 也被当作寒象参与自造 T5。真实应用命令四条反例：Q10B→肺经伏热（客户树应继续）、Q8B→脾气虚弱（应继续）、Q9B→肾阳不足（应肺气虚寒）、Q10A+Q11B+Q6B→寒热错杂（客户树第 1 步应直接肺经伏热）。线上浏览器完整对话再次复现 Q9B 最终误判肾阳不足。
> 另有流程偏离：线上不收集 Q2/Q3/Q4/Q5/Q7/Q12–Q14，Q11 被用于主判定而非仅辅助印证；现有 12 场景 benchmark 以代码自定义 v3 七规则为预期，因此全绿不能证明符合客户六步树。`docs/product/2026-08-09-智能体设计-决策记录.md` 已明写 v3 为作者/AI 代选且客户未回复，现却冻结为 approved，属于确认状态与发布状态错位。
> 材料自身仍有一个必须按客户最新口径落字的问题：六步树先规定 Q10A 立即肺经伏热、Q8A 立即脾虚，后面又二次询问同题并允许改成 A 以到肾阳不足/寒热错杂；若同轮答案不变，后两分支不可达。当前只完成诊断与证据收集，未修改规则、测试或部署。

> ## 🔧 修正方案方法展示与患者答案乱码（2026-08-09 第十九轮 · 未提交）
> 客户确认原临床材料中同一证型下的多项内容是供患者选择的方法，不是顺序步骤。固定方案模板已删除与列表重复的“手法”汇总段，将“步骤”改为“方法（请选择其中一项）”，并把操作视频位置移到每个方法下方；方案组末尾不再重复放总视频区。`vault/raw/clinical/急性期方案、调体方案（缓解期方案）.md` 保持只读。
> 修复按钮内部载荷直出：服务端对 `fieldCode=state` 等内部协议只用于确定性解析，持久化患者消息前映射为中文；Web 恢复历史时兼容转换旧记录，`pregnancy=no`、`diagnosed_confirmed=yes` 不再显示给患者。
> 验证：`npm run check` 全绿（含类型、架构、构建、全量 Node 测试与浏览器 E2E），`python3 scripts/structure-lint.py .`、`git diff --check` 通过。当前改动未提交、未部署；工作区原有第十七/十八轮调研文档改动均原样保留。

> ## ⏸️ 灵活问诊 Agent 改造暂停（2026-08-09 第十八轮 · 等待客户反馈）
> 作者决定暂停受约束对话 Agent 改造，待客户对交互形态、原始材料冲突及规则口径反馈后再决定是否实施。`docs/research/013_constrained-conversational-agent-research.md` 仅保留为调研依据，不视为批准计划；当前不修改业务代码、不部署，也不继续拆分实施任务。

> ## 🔬 受约束的灵活问诊 Agent 调研（2026-08-09 第十七轮 · 仅调研，未改业务代码）
> 对照客户原始《前置规则》《页面展示》、仓内患者 CLI 设计与现有实现，并调研 Rasa Flows/Slots/Conversation Repair、Dialogflow CX form filling、LangGraph.js interrupt/checkpoint、XState guard、HL7 FHIR Questionnaire/SDC 与 NIST AI RMF。结论：目标形态应为“受约束的混合主动式对话 Agent”——模型只把自然语言翻译为受控候选命令，患者确认事实后才进入确定性临床内核；按钮与文本共享同一语义入口，澄清/纠正/unknown/插话后继续/无法处理是显式对话状态。
> 仓库原设计方向正确但实现未闭环：candidate 已存库却无 adopt/modify/ignore 应用入口，Web 不接 proposedCandidates；选项卡与消息分离，服务端存内部载荷；没有 conversation repair。建议不引入第二套 Agent 运行时，复用现有 TypeScript 临床内核、会话持久化、CAS 与决策凭证，按 P0 单一 turn 契约 → P1 候选确认和修复模式 → P2 题库/规则/模板版本化实施。详见 `docs/research/013_constrained-conversational-agent-research.md`。
> 材料边界：raw 两份资料自身对期别判定存在 Q12–Q14 与 Q1–Q3 的字面冲突；技术只能忠实执行某个已确认版本，不能让互斥规则同时成立。raw 保留来源，客户确认后进入 truth/决策记录并编译为带 sourceRefs、版本和哈希的规则。本轮未修改代码、医学规则或部署。

> ## 🔍 “不清楚”重复补问根因确认（2026-08-09 第十六轮 · 仅诊断，未改业务代码）
> 截图现象已用真实 `agent exec` 两轮复现：`urgent_help=no` 后正确补问 `high_fever`；再提交 `high_fever=unknown`，服务端已把 unknown 写入确认事实，但助手正文只剩空问题前导语，响应 `verdict.nextQuestions` 仍返回 `high_fever`，Web 因而再次渲染同题选项卡。根因是逐题一问先把内核待答全集截为 1 题，conversation-service 再从这个已截断集合过滤 unknown，过滤后没有从 `allQuestions` 提升下一题；同时 API 返回与决策持久化仍使用过滤前 `verdict.nextQuestions`，造成正文、实时选项卡、刷新恢复三套状态不一致。安全语义未把 unknown 当 no，未误放行方案，但流程会卡住。
> 交互层另有结构问题：服务端助手正文已包含题目，Web 又在消息流末尾独立渲染同题选项卡，并非绑定到该助手消息；点击时友好答案气泡仅为前端瞬时视图，服务端保存的是 `fieldCode=state`/`qN=X` 协议载荷，刷新恢复会退化为原始载荷。自然语言模型候选也未接确认 UI，当前不能进入规则事实。
> 测试缺口：单测只断言 unknown 后会话未关闭/正文含前导语，未断言下一题推进及正文与结构化问题一致；浏览器 E2E 只点过“否”，从未点“不清楚”；12 场景 benchmark 无 unknown。建议修复时统一生成一份患者可见有效补问，供正文、API、持久化和恢复共用，并补 unknown 即时/刷新 E2E 与协议载荷友好恢复测试。本轮仅调研分析，未实施修复、未部署。

> ## ✅ 修复交互控件与多会话聊天并部署（2026-08-09 第十五轮 · 已合并部署 `b1ad92a`）
> 截图问题：①删除问助手输入栏左侧无实际功能的圆形按钮；②将共享底栏中央“＋”完整收纳在导航内，首页/问助手/日历/我的均加边界回归；其余负偏移均为受限容器内装饰，无同类控件越界。
> 对话问题根因与修复：旧前端只持久化 `conversationId`、气泡只在 React 内存，刷新后形成“新界面续旧后端”的状态错位，结束会话遂返回“不能继续回答”。现由 CLI-first 应用服务详情返回经解密与 SHA-256 校验的有序消息和最后补问，SQLite/PostgreSQL 双实现同步；Web 新增新建对话、患者隔离的历史列表/切换、刷新恢复、结束态只读及新建入口。过期/不存在/已结束不再用无效重试或静默重发创建新会话。
> 验证与交付：本地 `npm run check` 全绿（245 pass、75 项因未配置 PostgreSQL/S3 跳过），浏览器 E2E 覆盖刷新恢复、新 ID、历史切换、结束态禁用输入与无错误重试；PR #185 的 quality/image 全绿后 squash 合并为 `b1ad92a`。CI 曾因浏览器全链路集中命令超过默认限流而 429，已仅提高 E2E 实例额度，生产默认与限流专项测试未变。
> 部署：历史会话实证确认 SSH 使用 `/Users/chenqiqiang/.ssh/cezhang_tencent_120_53_103_145`（文件名不是目标主机）；新 release 先在 8788 临时库冒烟，再停服备份 SQLite/WAL/SHM 至 `/srv/kangmin-cli/data/backups/kangmin-mvp-20260809-1915-before-b1ad92a/`，原子切换 `/srv/kangmin-cli/app` 至完整 SHA release。`kangmin-cli` active，内外网 `/live` ok，线上三项 JS/CSS 与本地 `dist` SHA-256 一致，部署后 warning/error 日志为空。客户测试地址：`https://49.232.26.48`。
> 收尾：本地任务分支已在核验 PR 合并与成果完整后删除，远端分支按授权边界保留；最终再次运行结构检查、`git diff --check` 与 `npm run check` 均通过。部署目标/密钥误判教训已合并进 `state/memory/20260809-deploy-target-verify.md`，本轮无未落实事项，可关闭对话。

> ## ✅ 智能体设计 v4 开发轮完成并部署交付（2026-08-09 第十四轮 · 已提交，合并 `16b3888`，tag `customer-trial-2026-08-09`）
> 开发轮全部完成：ssh go/no-go（SQLite 确认、路径 /srv/kangmin-cli，线上服务为 kangmin-cli 而非 pioneer）→ 有界实验（规则穷举 31/32、迁移重建、选项映射）→ 迁移 0011/0012（+PG 0004，CI 质量门禁暴露后补）→ 规则包 v3 冻结（clinical-rules-v1 approved）→ 内核新流水线（safety→screening→phase→applicability→severity→syndrome→plan_safety）→ findApprovedPlanBundle 双方案 → 输出两套模板 → 管理端 ACUTE 特判 + phaseCode/audience 全链路 → seed 11 条（验收 enabled）→ 前端选项卡/结果卡/文案清理 → 冒烟。
> **评审收敛两轮通过**：三视角分身（冗余/并发边界/破坏旧功能，P0 无，P1/P2 全部修复——unknown 不再重问、期别缺失 fail-closed、no_match 终态一致、历史决策按行包状态裁剪、steps 对象渲染）+ codex（P1-2 历史决策解封、P2-2 steps 渲染、E2E 文案断言）+ CI PG 契约暴露（0004 迁移 + 302/303 用例 audience）。
> **部署**（kangmin-cli，caddy km2.49.232.26.48.nip.io/49.232.26.48 → 8787）：停服 → DB+WAL/SHM 备份（惯例名 backups/kangmin-mvp-<ts>-before-<sha>.sqlite）→ 解压 releases/16b3888 → node_modules 复用 → 软链切换 → drop-in 配 KANGMIN_DEEPSEEK_API_KEY → 启动（自动迁移 0011/0012）→ 清空旧会话（子表到父表）→ seed 11 条 ✅ → 线上冒烟 19 轮 ✅ → /live ok、/ready rule-package ok、前端资源 SHA 与本地 dist 一致。
> 交付链接：https://49.232.26.48 （km2.49.232.26.48.nip.io 同站）。tag：customer-trial-2026-08-09。
> 收尾：worktree/临时分支（dev-agent-v4-core/fix-pg-v4-migration/wt-*）全部清理，仅 main；云端/本地/git 已同步。
> 教训：①CI 有 PG 契约测试——PG 迁移必须与 SQLite 同步写（0004 补）②部署目标确认先于构建（pioneer 是旧 vinext 栈，kangmin-cli 才是本地项目）③macOS bsdtar 无 --transform 用 -s，打包含 .env.local 等敏感文件须排除。
> 待办：Q12-14 服务端信息收集路径（前端已静态省略，待客户确认）；PG 双方案查询已就绪未线上验证（预检 SQLite）；偏离清单 7 条 + 待客户确认清单 5 条待客户反馈；浏览门禁放开后患者 browse 全量方案口径待确认（评审 P2-2）。
> 补充：基准测试 `scripts/benchmark-assessment.mjs`（12 场景真实 CLI 全对话，12/12 通过，`dfef895`）已入库并同步服务器；架构变更记录 `docs/changes/arch/004` 已入库。

> ## ✅ 智能体设计计划 v4 定稿与作者拍板（2026-08-09 第十三轮 · 未提交，基线 `9e83c4a`）
> 计划经两轮 5 视角对抗评审 + codex 独立评审（共发现 P0 约 20 项、P1 约 30 项，重点：stage CHECK 迁移缺失、"不灸"子串误判、T5 与决定①相悖、planBundle 泄露、按钮载荷 message="" 死循环、seed 线上执行机制、32 组合互斥失实等），v4 全部闭环。**作者拍板 8 项**（AskUserQuestion 记录）：① 问卷多选题保真（原题原选项按钮，传选项值 q1=B 服务端映射，Q12-14 保留提问）；② 证型 v3 七规则（寒热错杂字面优先，供医学审核）；③ 删 APP-01 症状计数转介（确诊题承担门禁）；④ 儿童可用（删 SAF-07，按小儿方案）；⑤ 部署前清空线上旧会话；⑥ 有回退线（16:00 裁减，最坏保留现状 cc79ac5）；⑦ 今天冻结（approved + clinical-rules-v1）；⑧ 配模型 key（演示走自由文本+AI 提取，按钮兜底）。
> 计划定稿：`immutable-mixing-neumann.md` v4（含选项值映射表、findApprovedPlanBundle 双方案查询、31+1 组合穷举结论、DB 备份/清库事务、seed 禁占位文案、部署预检含数据库后端确认）。已知偏离清单 7 条（标供医学审核）。
> **分角色决策记录**：`docs/product/2026-08-09-智能体设计-决策记录.md`——AI 决策（A1-A10，实现层技术判断）/ 作者决策（拍板 8 项）/ 客户决策（decision.md）三分，含状态与回看指引；待客户确认清单 5 条。
> 验证：两轮评审与 codex 总判定一致——修正 P0 后今日交付可行；`docs/reviews/010` 为第一轮综合文档。
> 待办：作者确认后开工（开发轮第一步：ssh 只读验证 go/no-go——连通/数据库后端/模型 key → 建议 worktree 开发（工作区有未提交改动）→ 迁移→规则→内核→测试→前端→seed→部署）。今日交付底线 5 条不变；本轮全部文件（board/决策记录/010/计划）仍未提交，是否随开发轮一起 commit 待作者决定。

> ## 🔍 智能体设计计划与对抗评审（2026-08-09 第十三轮 · 未提交，基线 `9e83c4a`）
> 智能体设计改造计划（对话式评估全链路真实化：规则包冻结落 8 项决定、期别判定实现、筛选题+人群题、前端真实化、Web 部署）初稿完成，作者要求先对抗性评审再动手：5 个子 agent 并行、各持单一视角（临床规则/架构安全/数据一致性/前端演示/交付运维）挑刺。
> 评审结论：**计划方向正确但不可直接执行**——37 条 P0-P3（P0 十项：stage CHECK 约束迁移缺失、肺经伏热"不灸"子串误判 moxibustion、T5 `thirst=no` 与决定①相悖、判定回归、线上 seed 缺失、seed 无正文、选项渲染缺失、planBundle 患者侧泄露、模型不可用预案缺失、结果卡渲染空洞）。综合文档：`docs/reviews/010_agent-assessment-adversarial-review.md`（含每条依据文件:行）。
> 待作者拍板 3 问（修订计划前置）：① T5 寒热错杂判定（折中 vs 决定①字面，均标医学审核）；② Q1 期别映射（三值字段 vs 二元+映射规则）；③ 线上模型 key 现状（纯选项路径 vs 配 key 走自由文本）。
> 验证：5 视角总体判定一致（不能按当前版本执行）；docs/reviews/README.md 索引已更新。
> 待办：作者拍板 3 问 → 修订计划 → 实施 → 部署（今日交付底线 5 条不变，见下轮）。

> ## 📋 客户材料分析与决策前置（2026-08-09 第十二轮 · 未提交，基线 `9e83c4a`）
> 客户发来三份资料（`vault/raw/`：页面展示、前置规则、急性期/调体方案），用于智能体设计。逐份分析出材料层全部判断点，作者拍板 **8 项决定**（因客户急需、导师检查时限，未发客户，作者代选全部推荐项 A；客户反馈后按反馈调整）：
> ① 寒热错杂：Q11 选 B + 寒象（Q6 A 或 Q9 A）→ 判寒热错杂（供医学审核，待客户确认）；② 问卷加人群题（成人/儿童 12 岁以下）；③ 评估前加确诊确认题（否/不确定 → 提示门诊）；④ Q6 仅信息收集不参与判定；⑤ 期别判定以《前置规则》Q1/Q2/Q3 为准，Q12–14 保留提问仅信息收集；⑥ 缓解期按字面执行（Q1 选 C 即缓解期）；⑦ 证型展示名用简称；⑧ 欢迎语用《页面展示》版（带"敏友您好"）。
> 产出：`docs/product/2026-08-09-评估问卷与规则确认-decision.md`（决定+背景+待确认标记，**下一轮智能体设计真相源之一**）；Word 版问卷备存 `_work/20260809-assessment-decision/`（未发客户，如需再发需重新转换）。
> 下一轮真相源组合（冲突处以此为准）：① decision.md（8 项生效决定）② `vault/truth/` 4 份（客户确认基准）。truth 原文暂不加工，待客户确认后合并定稿。
> 设计层决定（2026-08-09 作者拍板）：交互形态 = **对话式**（客户展示稿为逐题问答呈现，现有 conversation-service 即对话式，保留主流程、改造量最小）；本轮交付 = **CLI + Web 前端**（Web 链接给客户验证，通过后最后上小程序）；验收边界 = **客户试用版可用**（规则冻结 + 核心链路通，管理后台方案录入客户自己弄，不阻塞）。
> 设计层默认 5 项：判定依据展示、自由问答本轮不做、评估结果保存、证型简称、欢迎语页面版。
> 验证：decision.md 与 word 内容核对通过；`docs/product/README.md` 目录规约符合。
> 待办：下一轮智能体设计开工——**今天（2026-08-09）必须交付 Web 试用链接**（导师检查，底线"说得过去"）。今日交付底线：① 规则包冻结并落 8 项决定（寒热错杂 T5 修正、期别规则、筛选题+人群题）；② 对话式评估全链路真实跑通（去掉"流程预览"标签）；③ 结果页按《页面展示》模板输出（急性期/缓解期两套文案+执行建议+免责）；④ 方案输出含证型对应手法清单（文本/视频占位，客户后台补）；⑤ Web 构建部署、链接交付客户。后续再上小程序。

> ## ✅ 上下文初始化复核与遗留处理（2026-08-09 第十一轮 · 已提交，基线 `877cc6d`）
> 复核 CLAUDE.md 上下文初始化：CLAUDE.md 引用的关键文件（board、MEMORY、目录协议、AGENTS、docs/README）全部存在，目录速查路径有效，`structure-lint.py` 通过，CLAUDE/AGENTS 除首行外一致，hooksPath 与 state/meta/skills 均已入库。
> 处理三处遗留：① `.claude/skills/` 内为 42plugin 第三方个人技能（dev-database-design、meta-42cog，license 42plugin-personal），非项目自产技能（自产技能按 `skills/README.md` 归根目录 `skills/`），加入 `.gitignore` 忽略，避免每轮污染 git status；② board 补记 #175/#176 提交（本记录）；③ 第十轮板面"git reset 教训候选"落地为 `state/memory/20260809-git-reset-check.md` 首条项目记忆并登记 MEMORY.md。
> 验证：`python3 scripts/structure-lint.py .`、CLAUDE/AGENTS 一致性、`git diff --check` 均通过。
> 提交：`d92f823`（教训入库+gitignore）、`9e83c4a`（board 补记）、`2099192`（/chats/ 忽略）经 PR #177 合并（squash → `addb1fa`），本地 main 已对齐远端、临时分支已清理。

> ## 🔧 手册治理修正与 work/ 归档（2026-08-08 第九轮 · 未提交，基线 `4ac5d69`）
> 审查 CLAUDE.md 手册发现矛盾与遗漏：钩子保护未入库、`ALLOW_MAIN_PUSH=1` 紧急通道未写入手册、AGENTS/CLAUDE 双份无同步规则、目录速查漏 product/changes、缺 `npm run check`、"_archive/ 全忽略"表述不准。作者拍板三项：`.githooks/` 入库、保留紧急通道但限作者显式授权、双份文件强制同步。
> `work/` 分流归档（作者确认）：`delivery-status.md` → `_work/20260805-cli-delivery-status/`、六轮 DB 评审 → `_work/20260731-db-design-review/`、6 张演示截图 → `_archive/20260804-demo-screenshots/`，根目录 `work/` 已删除（该目录在 .gitignore 中，删除不可从 Git 找回）。
> 落地：手册补 hooksPath 配置、ALLOW_MAIN_PUSH 授权边界、双文件同步纪律、速查补全与 `npm run check`，AGENTS/CLAUDE 同步修改（除首行标题外一致）；协议升 v1.3；`docs/reviews/007` 引用路径更新；`scripts/structure-lint.py` 新增 AGENTS/CLAUDE 一致性校验与 CLAUDE.md 必需文件检查。
> 验证：`python3 scripts/structure-lint.py .`、`git diff --check`、一致性校验正负向单测均通过。
> 提交：作者授权分三个 commit——`cbf2ad5`（钩子入库+手册同步）、`1da90ed`（work/ 归档+协议 v1.3）、`1a492ec`（lint 扩展+007 引用）；本文件与 `state/` 其余文件仍未入库，是否随 Git 同步待作者决定。

> ## 📤 存量改动提交、PR 合并与纪律调整（2026-08-08 第十轮 · 已提交，基线 `4ac5d69`）
> 作者授权将第九轮未入库内容连同存量改动一并提交：`483a2af`（仓库文档整理与结构迁移：docs 收敛新分类、旧 plans/decisions/runbooks/skills 与根 memory/ 删除、README 重写、.gitignore 重构、CONTRIBUTING.md 无引用删除）、`1bf34a9`（临床规则 sourceRefs 更新至 vault/truth，`npm run check` 全绿后提交）、`2b18753`（state/ 随 Git 同步入库）；随后 `6363885` 修复 CI 触发的 legacy 依赖高危漏洞 nanoid（`npm audit fix`，postcss moderate 暂不处理不阻塞门禁）。
> 上述全部经 PR #172 合并（squash → `60d2105`），quality/image 检查全绿；作者拍板移除「不自动提交/推送」与「PR 必须人工评审」两条纪律（AI 可直接提交与合并），经 PR #174 合并（squash → `d7b51a9`）。
> 教训：`git reset --hard` 曾误覆盖作者对 AGENTS.md/CLAUDE.md 的本地未提交修改（删除两条纪律），后按作者原意恢复；**resync 前须先检查工作区未提交改动并确认意图**，该经验已同步至 `state/memory/` 候选。
> 验证：`npm run check` 全绿、legacy 127 测试通过、lint 通过、双文件一致性校验通过；本地 main 与 origin/main 已对齐（fetch --prune 无残留分支）。
> 待办：`.githooks/pre-push` 钩子保留——手册仍保留 `ALLOW_MAIN_PUSH=1` 人工紧急通道条款，钩子拦截直推 main 正是该通道存在的意义，与手册自洽，无需改动（2026-08-08 作者确认）。

> ## 🔍 初始化一致性复核与修复（2026-08-07 第八轮 · 未提交，基线 `4ac5d69`）
> 统一 board 的每轮状态语义，清除 docs 中已删除的 meetings 和 `docs/客户资料/` 当前入口，规则来源改指向 `vault/truth/` 客户确认版本；`spce/` 与旧 `work/` 明确为本地保留资料，新内容分别进入 `docs/plan/` 与 `_work/`。
> 修复 Git 提交钩子，使 state/meta/docs/scripts 等治理文件可提交，同时继续拦截私密和本地目录；结构检查脚本改用 ASCII 文件名并补充导航断链、truth 来源链和废弃路径检查。根据现有项目记录，当前仍处于客户反馈验收阶段，入口为 `https://49.232.26.48`；本轮未重新核验线上可用性。商务记录为总额 2800 元、已收定金 1400 元，原件见 `vault/raw/business/`。
> 验证：`python3 scripts/structure-lint.py .`、活动文档链接、truth 来源链、`git diff --check` 和隔离索引 Git 钩子测试均通过；`src/` 的 `npm run check` 全部通过（含类型检查、架构检查、构建、Node 测试和 Web 浏览器端到端测试）。
> 待办：当前改动尚未提交，成果 commit 待作者授权后回写。

> ## 🧽 清理无关 D1 示例（2026-08-07 第七轮 · 未提交，基线 `4ac5d69`）
> 按作者确认删除与 kangmin 业务无关、且没有仓内引用的 `examples/d1/` Notes 示例；`notes/`、`scripts/`、`spce/` 按作者决定保留，未作修改。
> 验证：目标目录已删除，目录结构检查通过。
> 待办：当前改动尚未提交，成果 commit 待作者授权后回写。

> ## 🧹 初始化语义与跟踪规则纠正（2026-08-07 第六轮 · 未提交，基线 `4ac5d69`）
> 修正 `AGENTS.md` 中规约版本和 board 定义；修复 changelog 的 cezhang 路径残留；清除 raw/truth/规约及四份确认文件中擅加的独立临床复核与发布门禁状态，统一 truth 为“客户确认、当前开发和验收采用版本”；board 开工入口移除已删除的 `.42cog/`。
> 移除 `.git/info/exclude` 中“根目录仅允许 src/legacy”的本地限制，并按职责补全 `.gitignore`：治理文档可被 Git 识别，vault、客户资料、notes 和生成/过程目录继续保持私密或本地；`_archive/*-delisted/` 已实现显式放行。
> 验证：结构检查、truth 来源链、旧语义残留、Git 忽略规则和 `git diff --check` 均通过。
> 待办：当前改动尚未提交，成果 commit 待作者授权后回写。

> ## 🧩 目录速查按原版最小本地化（2026-08-07 第五轮 · 未提交，基线 `4ac5d69`）
> `AGENTS.md` 的目录速查恢复原版句式和层级，只做 kangmin 必要替换：vault 改为客户资料三层，state 恢复 board（AI 每轮），移除不存在的 sys-init，旧系统路径改为 `legacy/`；确认本仓没有会议文档，删除 `docs/meetings/` 并同步协议、导航和结构检查。
> 验证：`scripts/structure‑lint.py`、`git diff --check` 和 meetings 残留检查通过。
> 待办：当前改动尚未提交，成果 commit 待作者授权后回写。

> ## 📐 目录规约按参考版完成本地化（2026-08-07 第四轮 · 未提交，基线 `4ac5d69`）
> `meta/kangmin_directory-protocol.md` 按参考规约的“分区总览 → 各分区细则 → 命名汇总 → 检查”结构重写为 v1.1，忠实展开 `AGENTS.md`，不再扩写成综合治理手册；完成 `.42cog/source/spec` 裁剪、legacy 实际路径、vault 客户资料语义和 board 倒序轮次规则的本地化。
> 验证：协议路径与当前目录逐项核对；`git diff --check` 与结构检查通过。
> 待办：当前 `.gitignore` 仍使 docs/state/meta/vault 等新文件仅存在本地；是否调整跟踪范围由作者决定。

> ## 🧭 状态板规矩对齐（2026-08-07 第三轮 · 未提交，基线 `4ac5d69`）
> 按参考项目恢复状态板的倒序轮次日志格式：每轮使用独立引用块，直接记录本轮变化、验证和后续状态；删除误建的“当前阶段、正在进行、下一步、阻塞项”等固定看板栏目。
> 验证：`state/board.md` 格式检查通过；本轮尚未提交，`4ac5d69` 仅为工作区基线，不是本轮成果 commit。
> 待办：本轮初始化改动完成后，由作者决定是否提交。

> ## 🗃️ 客户资料分层与原件归档（2026-08-07 第二轮 · 未提交，基线 `4ac5d69`）
> `vault/raw/` 已按 business/clinical/content/product 分类：合同、定金凭证、报价表、临床规则、视频目录和页面内容均已归位；`word/` 混合目录已撤除。
> 四份客户确认材料已登记到 `vault/truth/`，保留 `source_file` 回溯链，并明确“客户已确认”不等于独立临床审核或生产发布批准。
> 验证：truth 来源链检查通过；`scripts/structure‑lint.py` 检查通过。
> 待办：对应原始 DOCX 当前不在工作区；如后续取得原件，再补做逐字复核。

> ## 🗂️ 仓库文档初始化与目录整理（2026-08-07 第一轮 · 未提交，基线 `4ac5d69`）
> 建立 `state/memory/MEMORY.md` 与 `meta/kangmin_directory-protocol.md`；`docs/` 收敛为 plan/reviews/research/meetings/product/changes，现有长期文档建立 001–012 编号索引。
> 设计、交付计划、修复方案和完成度评审已按内容迁移；README、有效相对链接和相关源码文档入口已同步更新，私密 `docs/客户资料/` 因临床来源路径依赖暂时保留。
> 验证：目录结构、Markdown 相对链接、编号唯一性和 `git diff --check` 均通过。
> 待办：当前根 `.gitignore` 会忽略除 `src/` 外的新文件，是否允许 docs/state/meta 随 Git 与 worktree 同步，待作者决定。
