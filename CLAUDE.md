# CLAUDE.md - 抗敏先锋AI鼻健康管理系统开发必读（kangmin）

> Agent 在本仓工作前必读：`state/board.md` + `state/memory/MEMORY.md` + `.42cog/intent.md`。
> 只放最关键的决策与纪律；系统是什么样见 `.42cog/`（陈述句），产出该长什么样见
> `specs/`（标准），目录语义展开见 `meta/kangmin_directory-protocol.md`（v1.8，唯一现行版）。
> `hi.md` 是我的手稿，你只读，不修改、不重排、不格式化、不加提示语。

## 系统与方向（指针，不抄副本）

- **系统是什么**：见 `.42cog/meta.md`；**朝哪使劲、真难题、不做什么**：见
  `.42cog/intent.md`；**给谁用、红线、资源**：见 `.42cog/real.md`；**系统里有哪些
  东西**：见 `.42cog/cog.md`。
- 方向类内容只放指针不抄副本——方向会改，抄出去的那份改不到，就成了错的。

## 项目状态入口

- **项目状态**：每轮实际变化、验证、遗留、待办和 commit 以 `state/board.md` 为唯一
  真相源，并按倒序追加，供 Agent 跨会话接续。
- **权威资料**：报价及客户确认采用的临床、内容、页面资料统一存放于 `vault/truth/`，
  是开发与验收唯一真相源，未经授权不得公开或提交。
- **权威顺序**：范围、所属端、价格和工期以 `vault/truth/抗敏先锋AI小程序报价表.md`
  为最高依据；报价范围内的题面、证型与期别、调理方法、视频分别由 truth 中对应专项
  文件裁决。`docs/`、`state/`、代码和测试均不得反向覆盖 truth；同一职责仍冲突或缺失
  时停止推断，待作者确认并写回 truth，AI 推断没有权威。
- **决策机制**：需客户拍板的事项详写在 `docs/product/YYYY-MM-DD-<topic>-decision.md`；
  若影响当前接续，本轮 board 只记录链接和状态，客户回复及实施结果在后续轮次回写。

## 智能体纪律

- **角色定位先行**：本项目智能体是面向患者的科普问答型（通用科普 + 引导问卷 +
  问卷后追问），不是写码/执行型；借鉴写码型框架只取最小循环结构，不照搬工具集。
  客户原始意图见 `vault/raw/chats/20260813-zhenyiwen-ai-dialogue.md`（私密原件），
  已拍板口径与遗留见 `state/board.md`；先内部实验跑通，再对客户承诺。
- **医学安全**：证型判定、诊疗框架和医学内容由 `vault/truth/` 与后台知识库唯一管控，
  AI 不自行推理证型、不脱离给定穴位/疗法新增方案。

## 目录速查

- `src/` 当前主实现 | `legacy/` 迁移前系统，仅作需求、行为和验收参考，禁止向 `src/` 导入其业务实现
- `.42cog/` 意向与认知（陈述句）| `specs/` 产出标准（含风格）| `vault/truth/` 唯一真相源（报价、临床、内容、页面）| `vault/style/` 品牌事实；不维护同内容 raw/加工副本
- `resources/` 外部参考区（只读、不裁决）；`resources/clones/` 外部克隆仓（不进 git）
- `state/` board（AI 每轮）· changelog（人类里程碑）· memory/（**项目记忆一律读写这里**，不用用户目录；涉隐私除外）
- `docs/{plan,reviews,research,experiments}` 编号过程文档 | `docs/{product,changes}` 客户决策与已采用变更 | `skills/` 自产技能源 | `meta/` 规约 | `notes/` 私区（**不修改不提交**）
- `_build/`（可重建）`_work/`（过程材料）`_archive/`（快照）—Git 忽略，仅 `-delisted` 结尾的下线件放行入库；旧系统见 `legacy/` 作参考
  - 三个忽略区**日期一律打头**，方能一路排序、一眼看出时间；均禁裸文件与目录混住（找起来累、管起来更累）
  - **`_work/`、`_archive/` 只许 `YYYYMMDD‑slug/` 目录**（最后更新日期制）；`_archive/` 里需入库可追溯的下线件以 `-delisted` 结尾（gitignore 靠该 glob 放行）
  - **`_build/` 只许 `YYYYMMDD‑HHMMSS/` 目录**，一次构建一个；按天分会撞车（一天出多版就互相覆盖）
  - 旧 `work/` 已归档入忽略区，过程材料一律进 `_work/`；`spce/` 为作者保留的本地设计资料，不提交
- 检查：`python3 scripts/structure-lint.py .`；`src/` 验证：`npm run check`

## 四大原则（默认遵循）

1. **决策前置化**：动手前先调研 + 冒烟确认足够上下文/权限，**列出需作者拍板的关键决策点**，对齐后才自主干活。把人介入前置到开工前。
2. **状态持久化**：唯一编码 + 状态外部化—文件即真相；跨会话/压缩后能接续（board / docs 编号 / state/memory）。
3. **能力弹性化 | 软技能，硬CLI**：软硬结合 + 技能编排；能固化成技能的经验固化进 `skills/`。
4. **工作并行化**：worktree 并行，**控制在 4 个以内**；派 worktree 前先 fetch；忽略件不进 worktree（任务别依赖，或初始化时软链）。

## 语言与长输出

- 注释/文档/提交/沟通**全部中文**；文件名默认英文；**AI 对话回答一律用中文**。
- **长输出**：单次回复 ≤400 token 为目标；超长内容按寿命分流：一次性→`_work/`、本轮变化/验证/遗留→board、经验→`state/memory/`、计划与需追溯内容→对应 `docs/` 分类。
- **文档命名规约**：memory `YYYYMMDD-<slug>.md` 使用最后更新日期（更新即改名并同步 MEMORY.md）；其他文档遵循 `docs/README.md` 及各分类索引，不另建全局编号体系。
- **规约命名**：`meta/kangmin_directory-protocol.md` 使用稳定文件名，版本和修订记录写在文件内部。

## Git 与工作流

- **无人值守自主边界**：破坏性/依赖口味/对外的活登记 follow‑up 待作者在场，绝不自动合并发版；`ALLOW_MAIN_PUSH=1` 紧急通道仅限作者显式授权后人工使用，AI 不得自行设置。
- **教训制度化 = 飞轮**：评审与改稿意见抽象成通用经验存 `state/memory/`（feedback 类，去细节留可迁移规律）+ 同步 PR 评论。
- **实证驱动**：结构或方案存在分叉时，先做有界实验并记录成本、证据与限制；评审只检查事实、逻辑、安全和合规问题，不裁决个人风格偏好。
- **AGENTS.md 与 CLAUDE.md 除首行标题外必须内容一致**（双入口同一内容）：修改任一份必须同步另一份，`scripts/structure-lint.py` 校验一致性。
- 每次改动 commit 附 trailer：
  - `Change-By: human`：改动由人类完成，Agent 仅辅助检查或执行命令。
  - `Change-By: ai`：改动由 Agent 独立完成，人类尚未参与修改。
  - `Change-By: ai+human`：Agent 与人类共同完成，或人类进行了实质修订。
  - `Agent:` 填写实际执行改动的 Agent 名称；纯人工改动填 `none`。
  - `Model:` 填写实际使用的模型；纯人工改动填 `none`。
- trailer 使用 ASCII 连字符并各占一行；禁止伪造未经本人确认的 `Reviewed-By`、`Co-authored-by` 等信息。
- commit 标题使用中文祈使句，说明“做了什么”；正文补充“为什么做”和关键取舍。
- 一个 commit 只处理一个可独立说明、验证和回退的主题；禁止混入无关格式化、临时文件或个人配置。
- 提交前检查 `git diff`、敏感信息和生成文件，并运行与改动范围匹配的测试；无法验证的内容写入 commit 正文和 PR。
- 修复评审意见时保留独立 commit 并说明对应问题；PR 合并前是否 squash 由作者决定。
