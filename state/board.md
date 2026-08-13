# kangmin · 项目状态板（唯一真相源 · 跨会话可接续）

> 开工先读 `AGENTS.md` + 本文件 + `state/memory/MEMORY.md` + `.42cog/intent.md`；目录语义见 `meta/kangmin_directory-protocol.md`。
> 轮规则：每轮有效项目工作必更新本文件（倒序追加，带日期与 commit hash；git 初始化前省略 hash）。

> ## ✅ exp001 原型跑通：千问约束对话 6/6 断言通过（2026-08-13 第四十八轮 · 基线 `main@e90f3ed`）
> H3/H4 原型两轮迭代收敛（产物与日志在 `_work/20260813-shiyi-shouce-inspect/`，看门狗全程值守）：首轮 6 回合暴露 F1（模型编造「3–5分钟/每日1次」操作数值）与两处断言 bug（A2 漏检 T1、A3「灸疗/灸」子串误报）；修断言 + 提示词加示范句后二轮全部 6/6 PASS，对已存答案重判确认无 API 额外成本。
> 证据要点：T1 生成通俗、名单外穴位零出现、数值编造消失（改用「以皮肤微红温热为度」）；T2/T3 越界疗法追问（刮痧/艾灸）均安全拒绝——「方案未包含，请咨询医生」，不展开越界操作；「迎香位置」追问给出通俗定位（小荷医生对标体验成立）。
> 三条发现已回写 exp001：F1 数值编造→提示词加固有效+生产层加输出校验；F2 操作方式自补（按揉/温敷/压豆）→接入时诊疗参数必须携带 truth 操作说明与视频引用，模型只做转译；F3 手册不含「鼻三线」（与 truth 互补、入库两者都进）+朴素检索召回差→向量（qwen3.7-text-embedding）或重排候选，报价外待拍板。
> 结论：可行性成立；生产化还需 F1–F3 闭环、模型定版（qwen-plus 可用，qwen3.7 系列候选）、检索拍板。待作者回场后：出接入方案 + 需求确认文档 v2。
> 验证：`python3 scripts/structure-lint.py .`、`git diff --check` 通过；本轮未 commit。

> ## 🔬 exp001 实验探索：冒烟通过、H2 检索实证、原型后台跑（2026-08-13 第四十七轮 · 基线 `main@e90f3ed`）
> 作者拍板：① 千问 API key 已入 `src/.env`（Git 忽略），`src/.env.example` 同步新增 KANGMIN_QWEN_* 三个空变量；② intent.md 已确认；③ 实验自主推进，作者离场。
> 冒烟三连通过：key 有效（账号 236 个模型、qwen 系 178 个，含 qwen3.5-ocr、qwen3.7-text-embedding）；qwen-plus 约束生成 PASS（名单外穴位零出现）；qwen-vl-plus 识别手册穴位图（合谷定位+操作）可用。发现 F1：模型自创「刮10–15次/揉1分钟」操作数值——穴位白名单守住但操作参数（次数/时长/力度）会编造，约束与断言须扩展，与 DeepSeek 抽取提示同一口径。
> H2 切块证据：142 块（71 块带穴位标签）；朴素 bigram 检索对患者提问召回差（目录块/动物实验块/拔罐块噪声），标签加权有限改善；手册正文不含「鼻三线」（与 truth 方案互补的语料缺口）。检索升级（向量 qwen3.7-text-embedding 或模型重排）列为候选，未实施（报价外基础设施需拍板）。
> H3/H4 原型已后台运行（`_work/20260813-shiyi-shouce-inspect/prototype_qwen.py`，2 案例×3 回合，断言 A1 白名单/A2 数值编造/A3 越界疗法追问），已挂 Monitor 看门狗盯 FAIL/越界信号；完成后回填 exp001 与 board。
> 验证：`python3 scripts/structure-lint.py .`、`git diff --check` 通过；本轮未 commit。

> ## 🧪 千问拍板、intent 确认、exp001 实验开跑（2026-08-13 第四十六轮 · 基线 `main@e90f3ed`）
> 作者拍板：① 模型用通义千问（具备图像识别能力，可用于手册穴位图识别）；② intent.md 确认无误（状态改「作者已确认 2026-08-13」）；③ 开始有界实验。
> 已落：`.42cog/real.md` 模型行回写（千问+视觉，DeepSeek 仍服务已上线 knowledge-qa）；`docs/experiments/001_zhenyiwen-constrained-dialogue.md` 开题（H1–H5 假设/做法/成本/限制，结论栏待回填）。
> H1 已通过：手册 17 个 docx 批量转 md 成功（76,065 字符，0 失败），目录/章节/表格保留，内嵌图片导出 `_work/20260813-shiyi-shouce-inspect/md/assets/`；转换脚本与产物均在忽略区（客户材料不入仓）。
> 遗留：H3–H5 需作者提供 DashScope API key 与千问模型名（生成/视觉用哪个）；H2 切块方案下一步（对齐现有知识库 knowledgeId+chunkIndex 结构）；本轮改动未 commit。
> 验证：`python3 scripts/structure-lint.py .`、`git diff --check` 通过。

> ## 🗃️ 过期起草件归档，活动文档只留当前有效（2026-08-13 第四十五轮 · 基线 `main@e90f3ed`）
> 作者指出 AI 这几轮搭的三份流程件已过期，全部归档至 `_archive/20260813-superseded-docs/`（含归档原因与取代者对照）：① 原始意图存档决策单（原文在 `vault/raw/chats/`，口径在 board）；② 需求确认文档（发送前必须先内部跑通可行方案，届时按 board 已拍板口径重出 v2）；③ research 002 五件套（方向已在对话直接拍板：追问入口 B、视频=文字回答+引用、分期按 truth 急性/缓解、手册实验先行、范围写死不反复改）。
> 索引与指针同步：docs/product/README 撤两条 2026-08-13 记录；docs/research/README 撤 002 链接（编号保留不复用，下一份 003）；docs/README 编号表更新（research 001–002 已归档 → 下一 003）；docs/plan/README 撤 002 取舍卡指针；`.42cog/intent.md` 上游锚点改指聊天原件与 board、冒烟三问第 3 答改「内部实验跑通后再出需求确认」；`.42cog/real.md` 模型选型指向 board 遗留；CLAUDE.md/AGENTS.md 智能体纪律改为「先内部实验跑通，再对客户承诺」。
> 遗留：① 模型选型（千问 vs DeepSeek vs 双适配器）仍待拍板；② 有界实验待开（手册切块 + 千问约束生成原型）；③ `.42cog/intent.md` 收敛方向第一句仍待作者表态；本轮改动未 commit。
> 验证：`python3 scripts/structure-lint.py .`、`git diff --check` 通过。

> ## 📋 需求确认文档按作者口径修订，手册解压盘点（2026-08-13 第四十四轮 · 基线 `main@e90f3ed`）
> 作者对需求确认文档提出修正：① 追问入口按客户聊天记录最终口径改为 B（入口=通用科普内容+引导问卷，问卷结束后才可追问），原推荐「入口即开放问答」与客户口径冲突且增加工作量，已撤；② 视频对标改为陈述「文字回答+视频引用」（小荷医生同款做法，千问不生成视频）；③ 手册改为内部测试先行——先解压转 md、切块、做问答实验，跑通可行后再请客户审核启用，不承诺做不到的效果；④ 年龄选择题保留；⑤ 轻重症不再设「新增判定」选项——已查 truth 前置规则：分期只有急性期/缓解期（Q12–Q14 判定，Q1 A/B→急性期，Q1C+Q2B+Q3B→缓解期），差异化话术按此分期表达即可；⑥ 范围约定写死「确认后按口径实施不反复调整，超出口径另行沟通单独排期」。
> 手册已解压到 `_work/20260813-shiyi-shouce-inspect/`（GBK 文件名用 Python 转码）：4 章 20 个文件（docx/doc 为主，含嵌套 rar/zip），转 md、切块与问答效果测试留待有界实验（expNNN）。
> 遗留：① 过期材料归档清单待作者圈定（候选：vault/style 未确认的 login 图、docs/research/001 旧基线调研、智能体设计决策记录中已标注失效的 v3 旧表）；② `.42cog/intent.md` 收敛方向第一段待作者表态；③ 需求确认文档发送时机=内部方案跑通之后；本轮改动未 commit。
> 验证：`python3 scripts/structure-lint.py .`、`git diff --check` 通过。

> ## 📋 起草客户需求确认文档（2026-08-13 第四十三轮 · 基线 `main@e90f3ed`）
> 已读作者 worklog（`notes/worklog/20260813.md`，只读不改）；聊天记录新增两条补充：客户发来小荷医生截图与《福建省中医药适宜技术手册》（完整收集版）zip，问「有没有必要喂给AI」，作者答复会出需求确认文档对齐后再开发，客户同意。
> 落档对外需求确认单 `docs/product/2026-08-13-zhenyiwen-requirement-confirmation-decision.md`（待作者审阅后发送）：已对齐口径五条复核 + 六道选择题（追问入口 / 回答+视频对标 / 手册喂不喂 AI / 年龄采集 / 轻重症口径 / 风险与范围约定），每项带推荐与影响说明；「超出口径的调整另行沟通单独排期」写进约定，防止无限返工。报价与商务口径未写入客户文档，是否提及由作者另行决定。
> 遗留：`.42cog/` 四份待作者过目（intent.md 收敛方向一句为重点）；客户文档推荐项（手册「先喂核心章节」、年龄「加一道题」等）待作者认可后发出；本轮改动仍未 commit。
> 验证：`python3 scripts/structure-lint.py .`、`git diff --check` 通过。

> ## 🗂️ 客户聊天记录归档职责确立（2026-08-13 第四十二轮 · 基线 `main@e90f3ed`）
> 作者确认两问：① 客户沟通原始聊天记录归 `vault/raw/chats/`（私密、随 vault 被 Git 忽略、只作追溯证据、不参与裁决；确认结论按职责进 truth 或 docs/product）；② vault/style 的客户 login 图不搬 specs/style——品牌事实归 vault/style、产出标准归 specs/style，两处分工不复制。
> 已落：`vault/raw/chats/README.md` + 首份记录 `20260813-zhenyiwen-ai-dialogue.md`（诊一诊对话原文）；`vault/raw/README.md` 恢复职责说明；协议 v1.7（raw/chats 语义）；决策单补原始记录指针。
> 遗留：login 图是否客户确认采用待作者答复（确认→留 vault/style 补来源注记；未确认→按 vault/style 规矩挪 `_work/`）；本轮改动仍未 commit，待作者确认后提交。
> 验证：`python3 scripts/structure-lint.py .`、`git diff --check` 通过。

> ## 🧱 按 aias-meta-init 内容标准重建初始化文档（2026-08-13 第四十一轮 · 基线 `main@e90f3ed`）
> 作者拍板三项（推翻第三十九轮「不引入技能默认骨架」决定）：① 重建 `.42cog/` 四份（intent 意向书 / real 现实约束 / cog 认知模型 / meta 项目身份）；② 新建 `specs/` 产出标准区（含 `specs/style/`，与 `vault/style/` 分工：品牌事实 vs 产出风格标准）；③ CLAUDE.md/AGENTS.md 按技能分工线改造为全祈使句+指针（「是什么」陈述段移入 `.42cog/meta.md`，必读行加 `.42cog/intent.md`，新增「系统与方向」「智能体纪律」两节）。
> `.42cog/intent.md` 已落：收敛方向「让过敏性鼻炎患者的每个健康问题得到有依据、说得俗、问得下去的回答与方案」+ 三闭环关联度量 + 真难题（医疗安全约束下的生成式对话，三级过滤）+ 五条排除清单 + 冒烟三问，标「待作者过目」；与 truth 分工写明：方向不改变医学事实，冲突时 truth 胜（回应第三十九轮双真相顾虑）。
> 协议升 v1.6：版本记录、本地化记录、分区总览与细则同步 `.42cog/`、`specs/` 语义；board 必读行同步加 `.42cog/intent.md`。
> 冒烟自检（技能放行判据）通过：全新上下文子代理只喂 `intent.md`，三问（朝哪使劲 / 不做什么 / 下一步=research 002 拍板 P1–P6 → 开 expNNN 实验）均凭原句答齐。
> 验证：`python3 scripts/structure-lint.py .`、`git diff --check` 通过。本轮与第四十轮改动均未 commit，待作者确认后提交。

> ## 🧭 客户原始意图落档，诊一诊调研重构为对话智能体方案（2026-08-13 第四十轮 · 基线 `main@e90f3ed`）
> 承接上一段会话未落板的收尾：作者拍板 `resources/clones/` 与 `resources/` 根分两区（外部克隆仓不进 git，手工材料随仓提交），`.gitignore` 已放行 `clones/README.md`；`docs/plan`、`docs/research` 索引已挂 002 调研。
> 客户 2026-08-13 就「诊一诊」提出理解偏差：问卷后输出固定模板、无法继续对话，与电话沟通的「知识约束赋能千问 + 持续追问」不符。原始对话全文与已确认口径落档 `docs/product/2026-08-13-zhenyiwen-ai-dialogue-decision.md`（`docs/product/README.md` 已登记）：判定逻辑保持不动；判定后把结构化参数（证型、分期、穴位清单、外治方式、约束规范）作为 Prompt 传给通义千问动态生成科普化、差异化文本；方案后可持续追问；最终口径「AI 仅提供通用科普 + 引导问卷，问卷结束后患者可追问」。
> research 002 由「患者知识问答（RAG）实现方案」重构为「诊一诊 AI 对话化（智能体）实现方案」，目录更名 `docs/research/002_zhenyiwen-ai-dialogue/`（未提交件，更名安全），五份文件按客户口径重填草稿：must-know 四条命门（判定由知识库管控 / 动态生成 / 持续追问 / 成本不超报价），sources 登记自有积累（src/agent 模块、research 001、truth）与他人积累（cc mini 要学的、cc/src 泄露源码红线不抄不克隆、opencode/pi 待克隆、小荷医生/豆包要比的、千问 API），gap 列出六项差距分级并建议开有界实验，decision 给出取舍卡草稿与 P1–P6 拍板栏（AI 不代填）；assign.md 派活模板保持原样。
> 新增项目记忆 `state/memory/20260813-agent-lens-patient-qa.md`：智能体调研先定角色——患者科普问答型，借鉴写码型框架只取最小循环结构，标杆是小荷医生，泄露源码不抄不克隆。
> 遗留（下一轮问作者，见 decision.md 拍板栏）：P1 模型选型（客户点名千问 vs 现网 DeepSeek，建议双适配器先跑实验）、P2 追问入口（建议按客户最终口径入口即开放科普问答）、P3 视频对标（千问不生成视频，拟以 truth 视频大全做回答+视频引用并向客户说明）、P4 追问与动态生成是否按报价 1,700 元内交付（客户口径认为电话沟通已含）、P5 检索是否升级（建议先保持 bigram+LIKE，实验取证再议）、P6 是否浅克隆 opencode/pi 进 `resources/clones/`。
> 验证：`python3 scripts/structure-lint.py .`、`git diff --check` 通过。本轮含上一段会话未提交件（.gitignore、两份 docs 索引、research 002、clones README），共 6 修改 + 4 新增，未 commit，待作者确认后提交。

> ## 🏗️ 按 aias-meta-init 框架补齐实验与参考分区（2026-08-13 第三十九轮 · 基线 `main@2abfef8`）
> 对照 aias-meta-init 技能六组骨架对 kangmin 做差距分析：六组（手册规约 · 真相源 · 脚本扩展 · 作品 · 状态文档 · 过程材料）均有对应区且协议更严，真正缺口仅两处，已按作者拍板补齐：
> ① 新增 `docs/experiments/` 有界实验分类——「实证驱动」原则（有界实验记录成本、证据与限制）此前无专门落点（进 `_work/` 会扔、进 board 会被压缩），现与 plan/reviews/research/changes 并列三位流水编号、从 001 起；`docs/README.md` 导航表、分类规则、编号表已同步。
> ② 新增 `resources/` 外部参考区（只读、不裁决、遵守版权红线），供文献、竞品、行业资料参考；不参与权威裁决（唯一真相源仍是 `vault/truth/`）；默认随仓库提交（gitignore 未忽略），不可公开复制的材料进 `notes/` 或 `_work/`。
> 明确不引入技能默认骨架：`.42cog/`（v1.4 协议已记作者删除，收敛方向权威在 `vault/truth/`，避免双真相）、`specs/`（meta 协议 + `vault/style/` 已覆盖）、`plugin.json`（插件打包用，kangmin 非技能集）。
> 协议 `meta/kangmin_directory-protocol.md` 升级 v1.5（分区总览、docs 细则、resources 细则、版本记录），CLAUDE.md/AGENTS.md 双入口已同步（目录速查 + 协议版本引用）。
> 验证：`python3 scripts/structure-lint.py .`、`git diff --check` 通过；未改业务代码，本轮改动未 commit（含 4 修改 + 2 新增），待作者确认后提交。

> ## ⛔ 无依据六步树撤销并停止相关开发（2026-08-11 第三十八轮 · 基线 `main@46f9df6`）
> 作者明确指出原 `vault/raw/clinical/syndrome-six-step-decision-tree.md` 不是其取得或可采用的客户资料。该文件及其直接派生的 truth 文件已删除，vault 索引已撤销“客户确认六步树”结论。按作者最终明确指令，`vault/raw/` 原有 4 份材料已原样移动到 `vault/truth/`，与报价 Markdown 一起构成 5 份唯一真相源；没有删除、回退或加工资料正文。`raw/` 当前只保留迁移说明，`business/` 已撤除。作者随后明确允许将报价 `.xlsx` 原件归档以便 AI 直接读取 Markdown；原件现位于 `_archive/20260811-quotation-original/`，不得删除。
> 现有 `src/` 的 `clinical-rules-v3`、六步树实现与相关测试，以及 007 计划和两份产品决策记录，仍包含这份无依据材料派生出的结论。本轮未擅自改业务代码或改写历史文档，后续开发立即停止；必须先依据《前置规则》重新核对受影响实现，形成有界回退清单并由作者确认后处理，不能继续把六步树当真相源。
> 验证：`vault/truth/` 根目录现有且仅有 5 份现行 Markdown 及 README，`vault/raw/` 仅有迁移说明，`vault/business/` 不存在；归档报价原件 SHA-256 仍为 `b27c044d7a50fca3e9401265213fd4c2ab758df8ed5511d69a0dd1977a17082f`。`python3 scripts/structure-lint.py .` 与 `git diff --check` 通过。
> 权威顺序已固化到报价 Markdown、truth 索引和 AGENTS/CLAUDE 双入口：报价表只在功能范围、所属端、价格和工期上最高；四份专项文件在各自职责内最高；docs/state/代码/测试不得覆盖 truth；职责内仍冲突或缺失时必须停下由作者确认，AI 推断无权威。
> 收尾自检确认本对话可以结束但不能直接进入新功能开发：truth 的 5 份 Markdown 完整，报价 `.xlsx` 归档哈希一致；truth 治理与文档分类编号已由 PR #196 squash 合并为 `40023d5`，`quality`、`image` CI 均成功，合并代码树与任务分支一致。首个任务分支、远端分支以及含两个独有提交的旧本地编号分支均已核验成果包含后删除，主工作区回到与 `origin/main` 一致。`src/modules/clinical-rules/`、相关测试、007 计划和两份产品决策记录仍引用已撤销的无依据六步树，下一窗口必须先按 5 份 truth 做受影响清单与有界回退，完成前不得把旧代码或历史文档当需求继续开发。本轮错误已抽象写入 `state/memory/20260811-material-relocation-scope.md`：移动不得扩大为删除、加工或归档其他文件，忽略区操作必须前后核对清单与哈希。

> ## 🔍 报价原件直接对齐与下一轮候选分组（2026-08-11 第三十七轮 · 基线 `main@46f9df6`）
> 已只读直接解析 `vault/raw/business/quotations/kangmin-mini-program-quotation.xlsx`（SHA-256 `b27c044d7a50fca3e9401265213fd4c2ab758df8ed5511d69a0dd1977a17082f`）的“功能清单”工作表；7 个报价项为智能辨证助手、症状评估、科普内容、基础页面、文章管理、视频管理和知识库管理。代码与现行状态显示：这些能力已在 CLI/Web 形成相应闭环，而仓库不存在微信小程序工程；因此下一阶段的确定性主缺口是将已有患者能力接入小程序薄壳，不是增加报价外功能或重做后台。
> 候选分组按交付边界合并为：① 小程序公共底座（工程、请求、微信登录、会话、五入口导航）；② 问助手（报价行 2）；③ 症状记录/日历/趋势（报价行 3）；④ 文章/视频/站内推送的患者查看（报价行 4）。管理后台 3 项（报价行 6–8）已交付，不进入下轮。建议首个 3 小时开发轮只做“公共底座 + 问助手最小主链路”，按工程骨架 → 请求/错误契约 → `wx.login`/Bearer 会话 → 首轮对话与历史恢复从低到高实施。此处只记录候选结论，待作者确认后再建正式计划，当前不占用 `docs/plan` 编号，未修改业务代码。
> 开工冒烟结论为“通过”：`main@46f9df6` 与 `origin/main` 一致，Node `v24.18.0`、npm `11.16.0`、现有依赖、微信开发者工具 `2.01.2510290` 及 CLI 可用，开发者工具已登录；使用已确认 AppID 的临时原生小程序工程可被 CLI 正常打开，临时件已清理。`npm run check` 全绿，公网 `/live` 有效 HTTPS 返回 200。当前 `/v1/auth/wechat` 如实返回 `capability_unavailable`，因此本轮按已拍板的可注入测试替身验证登录契约，不向作者索取 AppSecret；真实登录、合法请求域名和真机验收仍属后续阶段，不得被记为已通过。
> 45 分钟有界测试已提前收敛出关键结论：原生五入口组件可将中央“＋”保持为独立 `navigateTo` 新增动作，不用改成普通 Tab；可测试请求适配层实证 `wx.login` 后持久化 token、受保护请求携带 Bearer、401 清理失效会话以及超时明确失败全部可行。但现行患者 `nextQuestions` 契约只有 `fieldCode/prompt`，Web 依赖本地 `FIELD_TO_QUESTION + ASSESSMENT_QUESTIONS` 才能渲染 A/B/C/D 按钮；若直接开发小程序将迫使客户端复制题库，违反薄壳与单一来源约束。因此正式计划必须把“服务端患者问题展示 DTO 补充选项文案与受控提交值”置于小程序 UI 之前，内部临床 `NextQuestion` 与规则内核不变。附加限制：当前微信开发者工具已移除旧自动化 SDK 依赖的 `--auto-port` 入口，通用 GUI 读取通道亦无法启动；正式验收应使用可执行契约测试 + 开发者工具编译打开 + 人工点击清单，不得伪报全自动 UI 通过。
> 开始契约调整时发现报价原件及整个 `vault/raw/business/` 目录已不在当前工作区；仓库、用户目录、Spotlight 与废纸篓均未找到 `kangmin-mini-program-quotation.xlsx`。四份指定 Markdown 原始资料仍在。为避免凭旧摘录扩大或误判报价范围，业务代码调整已暂停；必须先由作者将原报价单恢复到指定路径，再重新核对 SHA-256 后继续。
> 作者随后将报价原件恢复，SHA-256 仍为 `b27c044d7a50fca3e9401265213fd4c2ab758df8ed5511d69a0dd1977a17082f`，与此前直接核验的原件完全一致。已按作者要求用 `42md` 转为 Markdown，并修正转换器对 Excel 合并单元格造成的列左移；复核确认 7 个功能项均为 5 列，价格合计 2,800 元，工期 15 个工作日。最终采用稿位于 `vault/truth/`，`.xlsx` 原件按作者后续指令归档。

> ## ✅ 文档分类编号治理完成并收紧范围核验（2026-08-11 第三十六轮 · 基线 `main@46f9df6`）
> `docs/plan`、`reviews`、`research`、`changes` 已改为各分类从 001 独立递增，13 组历史文档完成等行数重编号，相关索引、引用、目录规约和结构检查同步更新。未经权威原件核验的候选材料已完全移出正式文档且不占编号，未形成业务代码、数据库、部署或线上状态变化。
> 已新增范围核验项目记忆：正式开发计划必须区分明确交付功能、必要技术实现和候选产品改进；无法直接核验报价或客户确认原件时只能标记待核验，不得升级为开发授权。验证：`python3 scripts/structure-lint.py .`、`git diff --check` 通过；治理改动已提交为 `63c6a52`，未包含作者原有的 `AGENTS.md`、`CLAUDE.md` 改动。

> ## ✅ Web 阶段状态与 Git 收尾复核完成（2026-08-11 第三十五轮 · 基线 `main@399e32e`）
> PR #193 已合并业务实现为 `6ae634a`，PR #194 已合并部署状态为 `399e32e`，两轮 quality/image CI 均成功；原任务 worktree `/Users/chenqiqiang/work/kangmin-worktrees/production-readiness-admin`、本地分支和远端分支均已实际删除，`origin/main` 已包含全部实现与部署记录。此前只存在本地主工作区的第二十九至第三十三轮记录已在本轮按原始时间顺序补入，避免状态外部化断层。
> `docs/plan/008_tencent-cloud-production-cutover.md` 及文档索引已落实 Web 先验收、小程序后置、PostgreSQL/COS 正式切换待资源的边界；线上 `https://49.232.26.48` 继续运行 release `b8246fb`，服务 active、`NRestarts=0`，部署备份 quick_check=ok。现有 DeepSeek 密钥虽已迁至权限 `0600` 的服务器环境文件，但因部署检查阶段曾进入受控终端输出，仍须在正式生产前从供应商控制台轮换并更新服务器配置；该安全待办不阻断当前 Web 功能确认，但不得遗漏到正式生产验收之外。

> ## ✅ Web 运营能力已合并并部署试用环境（2026-08-11 第三十四轮 · 合并 `6ae634a`，PR #193）
> 作者确认的范围已落实：站内推送为应用内全员广播；调理方案后台编辑因报价单未包含而排除；正式存储采用腾讯云托管 PostgreSQL + COS。当前先以 Web 完成功能确认，原生小程序与体验码更新放到最后阶段；微信登录能力保留但以 `KANGMIN_WECHAT_ENABLED=0` 显式关闭，不阻断 Web 部署。管理 Web 已支持消息草稿/编辑/发布/下架，患者“我的→消息中心”支持列表、详情和按患者隔离的已读状态；SQLite `0016` 与 PG `0005` 同步增加回执表。
> 知识库已补齐分类、元数据更新、停用后删除及审计；患者“学一学→知识问答”只检索 enabled 分块，DeepSeek 可用时按已审核片段受约束生成并列来源，不可用时确定性降级为来源摘录，资料不足不自行补全。微信登录新增 `/v1/auth/wechat` code2Session、严格限流、7 天会话与 AppID+OpenID 不可逆摘要绑定；原始 OpenID、session_key、AppSecret 均不落库、不进日志。
> 生产侧已加入腾讯云配置模板 `src/.env.example`、只读容器 Compose、PostgreSQL/COS S3 兼容配置、COS virtual-host 寻址与先 HeadBucket 再签名；报价未含环境数据时以 `KANGMIN_ENVIRONMENT_ENABLED=0` 明确关闭而不伪装供应商。切换与待确认项详见 `docs/plan/008_tencent-cloud-production-cutover.md`。
> 验证：`cd src && npm run check` 全绿（336 tests：260 pass、76 项因未配置 PG/S3 跳过、0 fail，浏览器 E2E PASS）；`python3 scripts/structure-lint.py .`、`git diff --check` 通过。提交 `b8246fb` 已部署，PR #193 的 quality/image CI 均成功并 squash 合并为 `6ae634a`，合并代码树与任务分支一致；空库和线上 SQLite 副本在 8788 预检通过，副本迁移 17→20 且 quick_check=ok。停服前备份为 `/srv/kangmin-cli/data/backups/kangmin-mvp-20260811-134712-before-b8246fb.sqlite`，线上原子切换至完整 SHA release，旧版 `e87151d` 保留回滚；公网患者/管理 Web、消息列表、知识问答冒烟及两页构建哈希均通过，服务 active、`NRestarts=0`。上传包和预检库已清理，模型密钥已迁至权限 0600 的环境文件；正式 PostgreSQL/COS 云联调仍需实例与凭据，原生小程序后置。独立工作树未触碰主工作区作者改动，确认无未提交或未合并的独有成果，按作者指示进入工作树与分支清理。

> ## 🛠️ 生产基础设施与小程序身份入口确认（2026-08-10 第三十三轮 · 基线 `main@9b1b7b3`）
> 作者确认生产存储采用腾讯云托管 PostgreSQL + COS；现有 CVM 元数据确认地域为 `ap-beijing`、可用区为 `ap-beijing-6`，默认建议新资源同地域并通过私网连接。作者提供并要求记录自有微信小程序 AppID `wxec3aeaadcddaf45e`；AppID 是应用标识而非 AppSecret，AppSecret 必须只通过服务器密钥配置注入，不得写入仓库、状态板、小程序前端或聊天。
> 复核确认仓库当前没有小程序工程、`wx.login` / `code2Session` 服务端适配器或 OpenID/UnionID 身份绑定；患者 Web 仍依赖开发会话。因此正式生产改造必须包含小程序工程、微信临时 code 服务端换 OpenID/session_key、OpenID 映射本地 patient、HttpOnly 或小程序会话令牌、登出/过期/撤销及身份隔离测试；AppSecret 绝不下发客户端。
> 线上试用 SQLite 现有 21 个 patients、48 个 patient sessions、23 段 agent conversations、5 条症状、2 份档案、2 条用药与 3 条暴露记录；另有 3 条已发布内容、11 条已启用方案、2 个管理账号，知识和站内消息均为 0。生产迁移不得默认携带试用患者健康数据；尚需作者确认小程序最终归属主体、正式域名与备案、试用数据处置、生产 owner 账号归属、托管资源费用/规格及健康数据隐私与保留口径。

> ## ✅ 报价范围与生产化方向完成作者分流（2026-08-10 第三十二轮 · 基线 `main@9b1b7b3`）
> 作者确认：① 报价中的“推送”收口为小程序内部消息，不扩展微信订阅消息或系统级通知；② 调理方案后台编辑未写入报价单，不纳入本报价默认交付范围，后续产品记录中的“贵方后台编辑”需作为另行变更/增项处理；③ 本轮目标由客户试用环境升级为正式生产环境改造。
> 仓内已有 `content message` 的 CLI/应用服务/SQLite/PG 创建、更新、发布、下架与审计能力，但管理 Web 没有消息模块，患者端没有消息查询、已读回执、未读数、红点或内容跳转。按报价的最小完整实现确定为：广播全部小程序用户的站内消息，管理端可编辑/发布/下架，文章发布时可显式生成关联消息，患者端提供消息列表、未读数/红点、已读和跳转文章详情；不做用户分群、多渠道投递、定时推送或运营触达统计。
> 生产化现状约束：代码门禁强制 `production` 使用 PostgreSQL、S3 兼容对象存储、AES-256-GCM 密钥与真实环境 Provider；但当前 Web 不展示天气/空气/花粉数据，报价表也没有该功能，因此不应为未交付的环境功能强制购买供应商，应显式下线该区块并从生产就绪门禁移除。存储与身份仍需作者确认基础设施方案；当前患者 Web 依赖 `/dev/session`，改为 production 后该入口禁用，若无真实登录链路将无法进入业务，不能只替换环境变量就宣称生产化完成。

> ## 📋 管理后台按报价表重新分流（2026-08-10 第三十一轮 · 基线 `main@9b1b7b3`）
> 已只读复核 `vault/raw/business/quotations/kangmin-mini-program-quotation.xlsx`（SHA-256 `b27c044d7a50fca3e9401265213fd4c2ab758df8ed5511d69a0dd1977a17082f`）的“功能清单”工作表与可视排版。报价总额 2,800 元、总时间 15 个工作日；其中小程序 2,150 元，管理后台 650 元（文章 150、视频 100、知识库 400）。
> 确定性范围：① 规则引擎先确定证型，RAG 检索知识库，大模型只把规则结果转为自然语言解释，不得自行推理证型；因此知识库接入患者侧是报价内必做闭环，不再交由作者决定是否实施。② 文章必须支持新增、编辑、上下架及“向小程序用户推送”；视频必须支持上传、编辑和上下架。③ 知识库必须支持上传、更新、删除、分类、知识与检索索引维护，并供智能体 RAG 调用；当前 Web 只覆盖上传、索引、启停和检索测试，更新/删除/分类及患者侧 RAG 仍是确定缺口。
> 仍需作者确认的范围分叉：① “推送”是发布后在小程序内可见，还是微信订阅消息/站内消息；② 调理方案编辑与证型映射未出现在报价表，但后续产品决策记录写有“方案由贵方在管理后台关联编辑”，需判定为已承诺变更还是后续增项；③ 正式生产化、多管理员、审计日志查看、用户管理、复杂统计和模型参数中心均未在报价表单列，除安全运行所必须的最小能力外，不应默认扩大交付范围。

> ## 🔍 线上管理后台完善度复核（2026-08-10 第三十轮 · 基线 `main@9b1b7b3`）
> 使用重置后的主管理员账号登录线上 `/admin`，逐项复核工作台、文章、视频、知识库与素材库。当前 2 篇文章、1 个视频均已发布且校验通过，2 个素材可用；新增文章/视频表单完整可打开，本轮未保存、发布、下架、上传或删除任何内容。
> 主要缺口：① Web 无密码修改/重置入口，本次只能经运维直接重置；② 线上已有 11 条 enabled 调理方案，但 Web 无方案编辑/证型映射，与“客户在后台关联编辑方案”知悉项尚未闭环；③ 知识库当前为 0，空库检索仍只提示“已完成”而无“无命中”反馈，患者对话组合根也未消费管理知识仓储；④ 发布/下架会直接改变客户端可见性，页面无二次确认；⑤ 后端已有素材禁用/删除、分类编辑/停用、管理员管理、用户查询和模型配置等命令，Web 均未暴露，也没有审计日志查看入口；⑥ 移动样式在 760px 以下直接隐藏账号与退出操作。其中用户管理、复杂统计与模型参数中心是当前试用版显式边界，不与报价内的文章/视频/知识管理缺口混为同一优先级。
> 运行状态：`/live` 为 ok；`/ready` 仍返回 503，数据库、对象存储和规则包为 ok，加密密钥与真实环境数据 Provider 为 `not_configured`，因此仍只能定位为客户试用环境，不能按正式生产就绪交付。服务自密码重置后无 warning/error 日志，只读复核未发现页面崩溃或后台接口错误。

> ## 🔐 线上管理员密码安全重置（2026-08-10 第二十九轮 · 基线 `main@9b1b7b3`）
> 已对客户试用环境的 `demo-admin` 主管理员执行密码重置：操作前通过 SQLite 在线备份生成 `/srv/kangmin-cli/data/backups/kangmin-mvp-20260810-214042-before-admin-password-reset.sqlite`；新密码仅以 scrypt 哈希入库，本记录不保存明文。账号 revision 由 1 更新为 2，已撤销该账号全部旧会话，并写入 `admin.password_reset` 审计事件。回读新哈希并使用生产同源 `verifyPassword` 校验通过；未修改其他管理员或业务数据。

> ## ✅ 评估规则交付状态与文档自检完成（2026-08-09 第二十八轮 · 基线 `main@265d00c`）
> 已按“状态、计划、真相资料、索引、实现证据、Git 收尾”复核：PR #188 的业务修复已合并为 `c621704`，PR #189 的交付状态记录已合并为 `265d00c`，两项 CI 均为 success；本地与远端任务分支已清理，工作区仅保留与 `origin/main` 同步的 `main`。线上继续运行已完成 E2E 的 `e87151d`，其业务代码树与 `c621704` 一致，纯文档收尾无需重复部署；作者已向客户反馈。
> 文档落实：014 计划及索引均标记“已合并交付，客户已收到反馈”；页面、前置规则、六步树三份 truth 均存在且带 raw 来源，分别约束题面、通用/期别规则和有序证型跳转；方案 raw 继续只负责叶节点后的可选方法。代码侧共享题库、`clinical-rules-v3`、独立六步节点、旧会话 `abandoned` 和逐方法展示均有实现与测试引用。历史轮次中的“未合并/未部署”是当时事实快照，保留不改，不代表当前状态。当前无本任务未落实事项；儿童分流仍是已明确的资料限制，待客户另行补充题目与口径后再开新任务。
> 本次重新执行 `cd src && npm run check` 全绿（333 tests：257 pass、76 项因未配置 PG/S3 跳过、0 fail，浏览器 E2E PASS），`python3 scripts/structure-lint.py .`、`git diff --check` 通过，公网 `/live` 返回 `{"status":"ok"}`。仓库根目录没有 `package.json`，完整检查的规范入口是 `src/`，不将根目录误调用记为项目失败。

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
> 验证：111 条根到叶 A/B/C 路径逐前缀穷举通过；12/12 真实 CLI benchmark 通过；完整评估 smoke 通过；`npm run check` 全绿（330 tests：254 pass、76 项因未配置 PG/S3 跳过、0 fail）并包含浏览器 E2E；`python3 scripts/structure-lint.py .`、`git diff --check` 均通过。计划 `docs/plan/007_fix-ordered-syndrome-decision-tree.md` 已回写实现证据。当前只完成本地代码与文档修复，尚未 commit、PR、部署、清理线上旧会话或改变线上规则版本。

> ## ✅ 六步证型树规则与实施文档落地（2026-08-09 第二十三轮 · 文档完成，业务待实施，基线 `50df413`）
> 客户最新澄清已完成分层落档：来源整理为 `vault/raw/clinical/syndrome-six-step-decision-tree.md`，当前开发与验收规范为 `vault/truth/clinical/syndrome-six-step-decision-tree.md`；原 `assessment-rules.md` 只保留未被替代的通用、安全和期别规则。证型规范明确六个独立节点、A/B/C 跳转、命中叶子立即结束、Q8/Q10 二次确认独立存储，以及 Q1/Q2/Q5/Q7/Q11 仅作辅助印证。
> 两份产品决策记录已回写客户纠正：旧“Q11B + 寒象”和 v3 七规则标记为历史失效，不再作为实现依据；本次确认没有被扩大到年龄、确诊门禁、期别和安全规则。实施计划已登记 `docs/plan/007_fix-ordered-syndrome-decision-tree.md`，包含节点化数据模型、SQLite/PG 同步迁移、CLI/HTTP/Web 共用状态机、旧会话隔离、111 条根到叶路径穷举及关键错判回归。
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
> 作者决定暂停受约束对话 Agent 改造，待客户对交互形态、原始材料冲突及规则口径反馈后再决定是否实施。`docs/research/001_constrained-conversational-agent-research.md` 仅保留为调研依据，不视为批准计划；当前不修改业务代码、不部署，也不继续拆分实施任务。

> ## 🔬 受约束的灵活问诊 Agent 调研（2026-08-09 第十七轮 · 仅调研，未改业务代码）
> 对照客户原始《前置规则》《页面展示》、仓内患者 CLI 设计与现有实现，并调研 Rasa Flows/Slots/Conversation Repair、Dialogflow CX form filling、LangGraph.js interrupt/checkpoint、XState guard、HL7 FHIR Questionnaire/SDC 与 NIST AI RMF。结论：目标形态应为“受约束的混合主动式对话 Agent”——模型只把自然语言翻译为受控候选命令，患者确认事实后才进入确定性临床内核；按钮与文本共享同一语义入口，澄清/纠正/unknown/插话后继续/无法处理是显式对话状态。
> 仓库原设计方向正确但实现未闭环：candidate 已存库却无 adopt/modify/ignore 应用入口，Web 不接 proposedCandidates；选项卡与消息分离，服务端存内部载荷；没有 conversation repair。建议不引入第二套 Agent 运行时，复用现有 TypeScript 临床内核、会话持久化、CAS 与决策凭证，按 P0 单一 turn 契约 → P1 候选确认和修复模式 → P2 题库/规则/模板版本化实施。详见 `docs/research/001_constrained-conversational-agent-research.md`。
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
> 验证：两轮评审与 codex 总判定一致——修正 P0 后今日交付可行；`docs/reviews/004` 为第一轮综合文档。
> 待办：作者确认后开工（开发轮第一步：ssh 只读验证 go/no-go——连通/数据库后端/模型 key → 建议 worktree 开发（工作区有未提交改动）→ 迁移→规则→内核→测试→前端→seed→部署）。今日交付底线 5 条不变；本轮全部文件（board/决策记录/010/计划）仍未提交，是否随开发轮一起 commit 待作者决定。

> ## 🔍 智能体设计计划与对抗评审（2026-08-09 第十三轮 · 未提交，基线 `9e83c4a`）
> 智能体设计改造计划（对话式评估全链路真实化：规则包冻结落 8 项决定、期别判定实现、筛选题+人群题、前端真实化、Web 部署）初稿完成，作者要求先对抗性评审再动手：5 个子 agent 并行、各持单一视角（临床规则/架构安全/数据一致性/前端演示/交付运维）挑刺。
> 评审结论：**计划方向正确但不可直接执行**——37 条 P0-P3（P0 十项：stage CHECK 约束迁移缺失、肺经伏热"不灸"子串误判 moxibustion、T5 `thirst=no` 与决定①相悖、判定回归、线上 seed 缺失、seed 无正文、选项渲染缺失、planBundle 患者侧泄露、模型不可用预案缺失、结果卡渲染空洞）。综合文档：`docs/reviews/004_agent-assessment-adversarial-review.md`（含每条依据文件:行）。
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
> 落地：手册补 hooksPath 配置、ALLOW_MAIN_PUSH 授权边界、双文件同步纪律、速查补全与 `npm run check`，AGENTS/CLAUDE 同步修改（除首行标题外一致）；协议升 v1.3；`docs/reviews/001` 引用路径更新；`scripts/structure-lint.py` 新增 AGENTS/CLAUDE 一致性校验与 CLAUDE.md 必需文件检查。
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
