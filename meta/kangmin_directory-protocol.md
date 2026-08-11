# kangmin 目录规约（Directory Protocol）

> 本文件是 `AGENTS.md` 引用之“目录语义展开”的唯一现行版（v1.2），被
> `AGENTS.md` 路径引用，必须保持稳定：不编号、不带日期，版本走文件内记录 + Git。
>
> 语义来源：`AGENTS.md`（2026-08-07 整理，忠实收录，不扩写稀释）。
> 本地化记录：`.42cog/` 已由作者删除，不在本文重建；旧系统实际位于 `legacy/`，
> 不另建旧模板中的 `source/`；`spce/` 是作者决定保留的本地设计资料；vault 去除
> “策展”项目措辞。

## 版本记录

| 版本 | 日期 | 变更 |
| --- | --- | --- |
| v1.0 | 2026-08-07 | 由 `AGENTS.md` 目录语义整理成文 |
| v1.1 | 2026-08-07 | 按 kangmin 真实目录本地化；明确 board 倒序轮次、vault 客户资料分层及 docs 现行分类 |
| v1.2 | 2026-08-07 | 统一 board、客户确认资料和本地保留目录语义；修复 Git 与结构检查规则 |
| v1.3 | 2026-08-08 | 旧 `work/` 已完成分流归档并入忽略区，根目录不再保留；AGENTS.md 与 CLAUDE.md 双文件一致性纳入结构检查 |

## 分区总览

| 路径 | 定位 | 关键纪律 |
| --- | --- | --- |
| `vault/` | 客户与项目资料分层 | raw 保留来源；truth 保存客户确认采用版本；style 保存品牌规范 |
| `state/` | 状态区 | board（Agent 每轮）· changelog（人类里程碑）· memory（项目记忆） |
| `docs/{plan,reviews,research}` | 编号过程文档 | 文件名使用英文 `NNN_kebab-case.md`，流水不重排 |
| `docs/{product,changes}` | 决策与已采用变更 | product 放客户决策；changes 放长期变更记录 |
| `skills/` | 项目自有技能 | 只收已经验证、值得复用的能力 |
| `meta/` | 稳定规约 | 稳定文件名，不编号、不带日期 |
| `notes/` | 作者私区 | Agent 不修改、不提交 |
| `_build/` `_work/` `_archive/` | 忽略区 | 可重建输出、过程材料和快照 |
| `scripts/` | 检查与治理脚本 | 结构检查入口为 `scripts/structure-lint.py` |
| `src/` | 当前代码区 | CLI、应用服务、领域模块、适配器、测试和前端薄壳 |
| `legacy/` | 迁移前系统 | 只作需求、行为和验收参考，不向 `src/` 导入业务实现 |
| `spce/` | 保留的本地设计资料 | 不提交；新增长期设计进入 `docs/plan/` |

## 各分区细则

### vault/ 客户与项目资料

- `raw/`：收到时的来源版本，只整理路径和文件名，不改正文；按 business、clinical、
  content、product 分类，索引见 `vault/raw/README.md`。
- `truth/`：客户已经确认、当前项目采用的版本；它不是“加工稿”目录，文件必须保留
  到 `raw/` 的 `source_file` 来源链。
- `style/`：已确认的 Logo、颜色、字体、视觉和表达规范。
- `truth/` 中的客户确认版本是当前开发实现和验收依据。

### state/

- `board.md`：Agent 跨会话接续的唯一状态板。每轮有效项目工作必须在顶部倒序追加
  独立引用块，记录实际变化、验证、遗留/待办和 commit；未提交时写明当前基线，
  不把基线 SHA 冒充成果 commit。
- `changelog.md`：人类里程碑。只在作者认定形成重要成果时更新，不要求每轮同步。
- `memory/`：项目记忆一律读写这里，个人隐私除外。文件使用
  `YYYYMMDD-<slug>.md`，按最后更新日期命名；更新即改名并同步 `MEMORY.md`。

### docs/

- `plan/`：目标设计、交付计划和实施方案。
- `reviews/`：指定基线的代码、安全、业务和交付评审。
- `research/`：需要长期追溯的专题调研。
- `product/`：客户决策单，命名 `YYYY-MM-DD-<topic>-decision.md`。
- `changes/`：已经采用的重要架构、运维和修复记录。
- `plan/`、`reviews/`、`research/`、`changes/` 各自在分类内使用三位流水号，
  文件名一律英文 `NNN_kebab-case.md`；每类从 `001` 开始，编号永不重排、
  删除后不复用，同主题以该分类最新编号为准。
- 各分类当前索引和下一个编号以对应目录 `README.md` 为准；`docs/README.md`
  只汇总各分类编号状态。
- 客户来源统一进入 `vault/raw/`，客户确认采用版本进入 `vault/truth/`。

### skills/

项目自有技能源。只有流程已经验证、输入输出稳定且值得跨任务复用时才固化；不存在
的技能不得宣称“已可用”。

### meta/

规约文件使用 `kangmin_directory-protocol` 式稳定名，不编号、不带日期；规约被路径
引用，版本通过文件内版本记录和 Git 管理。

### notes/

作者私区，Agent 不修改、不提交，除非作者明确指定文件。

### src/ 与 legacy/

- `src/`：当前 CLI-first 主实现。
- `legacy/`：迁移前系统，只读参考；不得为了匹配旧模板另建 `source/`。

### spce/ 与已归档旧 work/

- `spce/`：作者决定保留的本地系统与数据库设计资料，继续由 Git 忽略；新设计不再
  写入这里，应进入 `docs/plan/`。
- 旧 `work/` 已于 2026-08-08 分流归档：`delivery-status.md` 与六轮数据库评审进
  `_work/20260805-cli-delivery-status/`、`_work/20260731-db-design-review/`，
  演示截图进 `_archive/20260804-demo-screenshots/`；根目录不再允许出现裸 `work/`，
  过程材料一律进入 `_work/`。

### 忽略区 `_build/` / `_work/` / `_archive/`

- `_build/` 保存可重建输出，使用 `YYYYMMDD-HHMMSS/`，一次生成一个目录。
- `_work/` 保存过程材料，使用 `YYYYMMDD-slug/`。
- `_archive/` 保存快照和下线内容，使用 `YYYYMMDD-slug/`；需入库追溯的下线件以
  `-delisted` 结尾，并在提交前核验隐私、来源和保留理由。
- 三个目录日期一律打头，禁止在根部混放裸文件与目录，不得成为代码运行的隐式依赖。

## 命名规约汇总

| 对象 | 格式 | 备注 |
| --- | --- | --- |
| 注释、文档、提交、沟通 | 中文 | 文件名默认英文 |
| `state/memory/` 记忆 | `YYYYMMDD-<slug>.md` | 最后更新日期制 |
| docs 编号区 | `NNN_kebab-case.md` | 英文；流水永不重排 |
| 客户决策 | `YYYY-MM-DD-<topic>-decision.md` | 放 `docs/product/` |
| 日期事件目录 | `YYYYMMDD-<slug>/` | 日期置前 |
| meta 规约 | `kangmin_directory-protocol.md` | 不编号、不带日期 |

## 检查

```bash
python3 scripts/structure-lint.py .
```
