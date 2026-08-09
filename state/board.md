# kangmin · 项目状态板（唯一真相源 · 跨会话可接续）

> 开工先读 `AGENTS.md` + 本文件 + `state/memory/MEMORY.md`；目录语义见 `meta/kangmin_directory-protocol.md`。
> 轮规则：每轮有效项目工作必更新本文件（倒序追加，带日期与 commit hash；git 初始化前省略 hash）。

> ## 🛠️ 修复交互控件与多会话聊天（2026-08-09 第十五轮 · 未提交，基线 `f661fa8`）
> 截图问题：①删除问助手输入栏左侧无实际功能的圆形按钮；②将共享底栏中央“＋”完整收纳在导航内，首页/问助手/日历/我的均加边界回归；其余负偏移均为受限容器内装饰，无同类控件越界。
> 对话问题根因与修复：旧前端只持久化 `conversationId`、气泡只在 React 内存，刷新后形成“新界面续旧后端”的状态错位，结束会话遂返回“不能继续回答”。现由 CLI-first 应用服务详情返回经解密与 SHA-256 校验的有序消息和最后补问，SQLite/PostgreSQL 双实现同步；Web 新增新建对话、患者隔离的历史列表/切换、刷新恢复、结束态只读及新建入口。过期/不存在/已结束不再用无效重试或静默重发创建新会话。
> 验证：`npm run check` 全绿（245 pass、75 项因未配置 PostgreSQL/S3 跳过）；浏览器 E2E 覆盖刷新恢复、新 ID、历史切换、结束态禁用输入与无错误重试；`python3 scripts/structure-lint.py .`、`git diff --check` 通过。本地服务已按新构建重启于 `http://127.0.0.1:8787`（`/live` ok）；改动尚未提交。

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
