# 四组功能—测试覆盖账本

> 状态：核心与内容入口已合并；症状管理入口正在按 #334 单独交付，基础壳另行排期
> 日期：2026-08-27
> 事实基线：`origin/main@226905d`（#334 候选工作树另有未提交测试入口）
> 对应 Issue：[#331](https://github.com/Bwkyd/kangmin-pioneer-ai-health/issues/331)

## 当前状态

仓库已有单元、应用、契约、真实进程与浏览器 E2E，但日常入口仍主要是
`cd src && npm run check`。局部修改前需人工回忆应该跑哪些文件；测试数量已经增长，
可发现性和最窄确认入口没有同步形成。

本账本把报价内行为收入四组，是产品与测试导航，不是代码目录重组设计。

本轮 #334 候选快速检查点：

`cd src && npm run test:smoke:record`：逐条确认症状保存/回读、日历趋势投影与缺失值
边界；目标名漂移、零/部分命中或断言失败均 exit 1。该命令不替代 PostgreSQL 契约。

## 目标与非目标

目标：

- 让一次典型修改能先找到对应行为、现有证据、层级与最窄命令。
- 把真正没有证据的地方与“已有证据、只缺快速入口”分开。
- 让 #332–#334 各自只交付一个可运行、会失败、可回退的快速确认入口。

非目标：

- 不修改 `src/`、truth、医学规则、数据库 schema 或生产环境。
- 不拆分长文件，不为分组搬目录，不复制 fixture。
- **测试密度只作趋势哨兵，不设测试数量目标**，不把账本行数当覆盖率。

## 四组边界

| 分组 | 收入哪些变化 | 不收入哪些变化 |
| --- | --- | --- |
| 核心·智能调理 | 问卷推进、确定性证型/分期/方案、安全分流、模型降级、会话恢复 | 知识资料如何上传和启用，归入内容供给 |
| 辅助·内容供给 | 知识、文章、视频、站内消息从运营维护到患者/RAG 消费 | 知识命中后如何做临床裁决，仍归入智能调理 |
| 次要·症状管理 | 量表、按日记录、档案、暴露/用药、日历、趋势与缺失值语义 | 登录、导航与展示壳本身，归入基础壳 |
| 次要·基础壳 | 登录/会话、首页、固定导航、小程序平台适配、加载/错误外壳 | 页面内真实业务结果，按前三组归类 |

归类对象是“可辨识行为”，不是测试文件。一个综合测试文件可以为不同行为提供
证据，但同一行为只在一组登记；因此不为凑四组拆解天然连续流程。

## 行为覆盖账本

命令都包含构建，避免误跑过期 `dist/`。“已知缺口”记录下一步确认成本，不等于
当前产品缺陷。

| ID | 分组 | 可辨识行为 | 现有证据 | 层级 | 最窄运行命令 | 已知缺口 |
| --- | --- | --- | --- | --- | --- | --- |
| KM-CORE-01 | 核心·智能调理 | 页面问卷完整推进并经确定性规则得到分期与方案 | `src/tests/clinical-rules.test.ts`、`src/tests/agent-conversation.test.ts` | 内核 + 真实 SQLite E2E | `cd src && npm run build --silent && node --test dist/tests/clinical-rules.test.js dist/tests/agent-conversation.test.js` | 证据充分；缺少只锁定一条代表路径的稳定快速入口 |
| KM-CORE-02 | 核心·智能调理 | 六步证型树 111 条路径有序到叶，非 A/B/C 失败关闭 | `src/tests/syndrome-decision-tree.test.ts`、`src/tests/clinical-rules.test.ts` | 黄金单元 + 内核 | `cd src && npm run build --silent && node --test dist/tests/syndrome-decision-tree.test.js dist/tests/clinical-rules.test.js` | 已有穷举；不应再复制一份冒烟样例 |
| KM-CORE-03 | 核心·智能调理 | 高危输入在模型前阻断，`unknown` 不得当成 `no` | `src/tests/clinical-rules.test.ts`、`src/tests/agent-conversation.test.ts` | 内核 + 应用 E2E | `cd src && npm run build --silent && node --test dist/tests/clinical-rules.test.js dist/tests/agent-conversation.test.js` | 缺少针对快速入口的故意破坏证明 |
| KM-CORE-04 | 核心·智能调理 | 模型不可用时返回固定安全降级，规则结果仍有效 | `src/tests/model-ports.test.ts`、`src/tests/agent-conversation.test.ts` | 端口 + 应用 E2E | `cd src && npm run build --silent && node --test dist/tests/model-ports.test.js dist/tests/agent-conversation.test.js` | #332 应复用已有断言，不新增另一套降级 fixture |
| KM-CORE-05 | 核心·智能调理 | 会话恢复继承评估上下文，不重做问卷且不混入旧规则 | `src/tests/agent-conversation.test.ts` | 真实 SQLite E2E | `cd src && npm run build --silent && node --test dist/tests/agent-conversation.test.js` | 当前只能按整个长文件运行，按名称筛选需 #332 实验稳定性 |
| KM-CONTENT-01 | 辅助·内容供给 | AI 知识资料从登记、建索引、启用、测试到停用 | `src/tests/admin-agent.test.ts` | 应用 + SQLite | `cd src && npm run build --silent && node --test dist/tests/admin-agent.test.js` | 状态机已有证据；缺少面向运营到患者的单命令入口 |
| KM-CONTENT-02 | 辅助·内容供给 | 启用资料可参与语义检索，停用资料被排除 | `src/tests/semantic-knowledge-retrieval.test.ts` | 检索契约 | `cd src && npm run build --silent && node --test dist/tests/semantic-knowledge-retrieval.test.js` | 已覆盖两个状态；与运营生命周期的组合入口待 #333 建立 |
| KM-CONTENT-03 | 辅助·内容供给 | 文章发布后患者可见，下架后不可见 | `src/tests/admin-content.test.ts`、`src/tests/browse.application.test.ts` | 应用闭环 | `cd src && npm run build --silent && node --test dist/tests/admin-content.test.js dist/tests/browse.application.test.js` | 已有正负状态；无需为 #333 重复增例 |
| KM-CONTENT-04 | 辅助·内容供给 | 视频只有绑定可用素材并发布后才能被患者使用 | `src/tests/admin-content.test.ts`、`src/tests/plan-video-matching.test.ts` | 应用 + 匹配契约 | `cd src && npm run build --silent && node --test dist/tests/admin-content.test.js dist/tests/plan-video-matching.test.js` | 真实 S3 上传不属于本地快速冒烟，继续留在 CI 契约 |
| KM-CONTENT-05 | 辅助·内容供给 | 站内消息需登录，只有发布后可见且已读状态按患者隔离 | `src/tests/browse.application.test.ts`、`src/tests/miniprogram-shell.test.ts` | 应用 + 小程序壳 | `cd src && npm run build --silent && node --test dist/tests/browse.application.test.js dist/tests/miniprogram-shell.test.js` | 不纳入 #333 首条知识冒烟，避免一次小交付混多种内容 |
| KM-RECORD-01 | 次要·症状管理 | 症状记录创建、查询、更新、删除与幂等/CAS | `src/tests/application.test.ts`、`src/tests/record-production.test.ts` | 应用 + 生产存储 | `cd src && npm run build --silent && node --test dist/tests/application.test.js dist/tests/record-production.test.js` | 行为充分；#334 只需选代表路径建稳定入口 |
| KM-RECORD-02 | 次要·症状管理 | 缺失、未读取或解密失败不伪装成空数据或真实零值 | `src/tests/record-production.test.ts`、`src/tests/miniprogram-shell.test.ts` | 存储 + 展示壳 | `cd src && npm run build --silent && node --test dist/tests/record-production.test.js dist/tests/miniprogram-shell.test.js` | #334 需选定一个缺失值断言作失败注入，不再造 fixture |
| KM-RECORD-03 | 次要·症状管理 | 按日保存后在月历与趋势中按区间、排序和软删除规则回显 | `src/tests/application.test.ts`、`src/tests/pg-record-repository.contract.test.ts` | 应用 + 双后端契约 | `cd src && npm run build --silent && node --test dist/tests/application.test.js dist/tests/pg-record-repository.contract.test.js` | 本地未配 PG 时契约会跳过；快速通过不得冒充双后端通过 |
| KM-RECORD-04 | 次要·症状管理 | 客户体验版未配微信登录时本机保存仍贯通概览、日历和趋势 | `src/tests/miniprogram-shell.test.ts` | 小程序页面壳 E2E | `cd src && npm run build --silent && node --test dist/tests/miniprogram-shell.test.js` | 这是开发体验降级，不等于正式微信身份链验收 |
| KM-SHELL-01 | 次要·基础壳 | 微信登录换取患者会话，401 只清理旧令牌并重试一次 | `src/tests/miniprogram-shell.test.ts`、`src/tests/account.test.ts` | 平台适配 + 账户 | `cd src && npm run build --silent && node --test dist/tests/miniprogram-shell.test.js dist/tests/account.test.js` | 正式微信账号与真机仍是外部实效验收，不能用本地测试替代 |
| KM-SHELL-02 | 次要·基础壳 | 小程序首页保持四条功能入口和五项主导航 | `src/tests/miniprogram-shell.test.ts` | 静态 + 页面壳 | `cd src && npm run build --silent && node --test dist/tests/miniprogram-shell.test.js` | 已与业务页面断言同文件；本批结束后再决定是否建单独壳冒烟 |
| KM-SHELL-03 | 次要·基础壳 | 问助手请求失败后移除思考态、保留输入并给安全重试 | `src/tests/miniprogram-shell.test.ts` | 小程序页面壳 | `cd src && npm run build --silent && node --test dist/tests/miniprogram-shell.test.js` | 只锁定交互壳，回答医学边界仍由核心组测试负责 |
| KM-SHELL-04 | 次要·基础壳 | 生产/staging 缺供应商或开发开关时失败关闭 | `src/tests/config-gates.test.ts` | 配置门禁 | `cd src && npm run build --silent && node --test dist/tests/config-gates.test.js` | 不归入任一业务组；这是整个运行壳的入口不变量 |

## 实测基线

测量环境：macOS，Homebrew Node `22.23.1`（仓库 `.nvmrc` 为 `22.13.0`，同 Node 22 主版本），
`origin/main@9a38dd1`。当前终端默认是 Node 24.18.0，下表统一使用已安装的 Node 22.23.1
进程路径，不把默认运行时混入基线。

### 完整门禁实测

| 命令 | 结果 | 实时 |
| --- | --- | --- |
| `cd src && npm run check` | 类型、架构、小程序检查通过；Node 438 项中 360 通过、78 跳过、0 失败；真实 Chromium E2E PASS | 46.20 s |
| `cd src && npm run build --silent` | 构建通过 | 2.58 s |

### 四组后构建窄测

下列时间是同一次已构建 `dist/` 上的测试进程时间；安全的常规窄测命令还应加上
2.58 s 构建，仍显著小于 46.20 s 完整门禁。

| 分组 | 测试文件 | 后构建实时 |
| --- | --- | --- |
| 核心·智能调理 | clinical-rules + syndrome-decision-tree + agent-conversation + model-ports + medical-publication-gate | 1.97 s |
| 辅助·内容供给 | admin-agent + semantic-knowledge-retrieval + admin-content + browse.application | 1.64 s |
| 次要·症状管理 | application + record-production + pg-record-repository.contract | 1.32 s（PG 未配时相关项跳过） |
| 次要·基础壳 | miniprogram-shell + account + config-gates | 1.50 s |

### 外部适配器跳过项

- PostgreSQL：66 项，原因为本机未配置 `KANGMIN_TEST_DATABASE_URL`。
- S3/MinIO：12 项，原因为本机未配置 `KANGMIN_TEST_S3_ENDPOINT` /
  `KANGMIN_TEST_S3_BUCKET`。
- 这 78 项在本地跳过是环境事实，不等于通过；完整 PostgreSQL 16 与 MinIO/S3
  证据继续由 PR CI 强制。

## 已知缺口与下一步

### 结论

当前首要缺口不是“没有测试”，而是四组窄测没有稳定命令、运行边界和故意失败
证明。因此后续先复用现有高信号断言；只有具体行为在账本中被标为“明确缺口”时，
才新增用例。

### 下一条最小补测候选

[#332](https://github.com/Bwkyd/kangmin-pioneer-ai-health/issues/332) 先建立
`test:smoke:core`（名称可在实现时按现有脚本约定微调），只锁定两个已有行为：

1. 一条代表性问卷经确定性规则得到方案。
2. 模型不可用时安全降级，不改变规则结果。

先试验 Node `--test-name-pattern` 能否稳定锁定这两项；如果名称筛选容易漂移，再评估最小
测试入口文件。不在 #332 顺带拆分长测试。

后续顺序：#332 → #333 → #334。基础壳已有广泛壳层证据，等前三条得到真实
耗时、失败注入和维护经验后，再决定是否建第四个冒烟入口。

## 验收与限制

- 机械验收：`python3 scripts/check-test-coverage-ledger.py .`。
- 文档门禁：清单、结构、链接与 `git diff --check`。
- 测试证据只说明指定基线与环境下的工程行为，不扩大为客户验收、临床批准、
  正式微信身份链或生产就绪。
- 账本不按每个函数、文件或用例逐一列举；它的粒度是“下一次真实改动要确认的
  可辨识行为”。

## 收尾证据

- 机械检查先在账本不存在时退出 1，建账本后通过：18 个行为、四组均不少于 2 项。
- Node 22.23.1 完整 `cd src && npm run check` 退出 0：438 项中 360 通过、
  78 项按外部适配器约定跳过、0 失败，Chromium E2E PASS，实时 46.20 s。
- 四组后构建窄测均退出 0；脚本 Python 编译、清单和 `git diff --check` 通过。
- 隔离 worktree 的结构检查因忽略的私有 `vault/raw`、`vault/truth`、`vault/style`
  不存在而失败；根工作区复跑只报两个任务前已有的 `_work/` 中文目录名。
  本 Issue 不依赖、不修改这些忽略区材料。
- 本轮未改 `src/`、truth、生产环境或患者数据；不宣称已提交、PR、CI、合并或部署。
