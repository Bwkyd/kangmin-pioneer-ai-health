# kangmin · 项目状态板（唯一真相源 · 跨会话可接续）

> 开工先读 `AGENTS.md` + 本文件 + `state/memory/MEMORY.md`；目录语义见 `meta/kangmin_directory-protocol.md`。
> 轮规则：每轮有效项目工作必更新本文件（倒序追加，带日期与 commit hash；git 初始化前省略 hash）。

> ## 🔧 手册治理修正与 work/ 归档（2026-08-08 第九轮 · 未提交，基线 `4ac5d69`）
> 审查 CLAUDE.md 手册发现矛盾与遗漏：钩子保护未入库、`ALLOW_MAIN_PUSH=1` 紧急通道未写入手册、AGENTS/CLAUDE 双份无同步规则、目录速查漏 product/changes、缺 `npm run check`、"_archive/ 全忽略"表述不准。作者拍板三项：`.githooks/` 入库、保留紧急通道但限作者显式授权、双份文件强制同步。
> `work/` 分流归档（作者确认）：`delivery-status.md` → `_work/20260805-cli-delivery-status/`、六轮 DB 评审 → `_work/20260731-db-design-review/`、6 张演示截图 → `_archive/20260804-demo-screenshots/`，根目录 `work/` 已删除（该目录在 .gitignore 中，删除不可从 Git 找回）。
> 落地：手册补 hooksPath 配置、ALLOW_MAIN_PUSH 授权边界、双文件同步纪律、速查补全与 `npm run check`，AGENTS/CLAUDE 同步修改（除首行标题外一致）；协议升 v1.3；`docs/reviews/007` 引用路径更新；`scripts/structure-lint.py` 新增 AGENTS/CLAUDE 一致性校验与 CLAUDE.md 必需文件检查。
> 验证：`python3 scripts/structure-lint.py .`、`git diff --check`、一致性校验正负向单测均通过。
> 提交：作者授权分三个 commit——`cbf2ad5`（钩子入库+手册同步）、`1da90ed`（work/ 归档+协议 v1.3）、`1a492ec`（lint 扩展+007 引用）；本文件与 `state/` 其余文件仍未入库，是否随 Git 同步待作者决定。

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
