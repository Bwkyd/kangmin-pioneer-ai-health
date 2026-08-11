# 抗敏先锋 AI 鼻健康管理系统

本仓库采用 CLI-first 架构。`src/` 是当前主实现，交付患者端
`kangmin`、管理端 `kangmin-admin`、版本化 HTTP 命令服务和患者 Web
薄壳；`legacy/` 完整保留迁移前的 Vinext/Cloudflare 产品，只作为需求、
行为和验收参考。`src/` 不得导入 `legacy/` 的业务状态或框架模块。

本 README 是人和 AI Agent 的仓库入口与执行协议。详细命令、配置、错误码
和已知限制见 [`src/README.md`](src/README.md)；开始任何任务前必须先读
[`AGENTS.md`](AGENTS.md)。若文档与当前代码、CLI `--help` 或测试冲突，以
可执行证据为准，并修正文档，不能按过期说明猜测。

## 快速导航

| 目标 | 从这里开始 |
| --- | --- |
| 第一次运行当前系统 | [环境与快速开始](#环境与快速开始) |
| 查看 `kangmin` / `kangmin-admin`、HTTP 与配置 | [`src/README.md`](src/README.md) |
| 开始 AI Agent 代码任务 | [AI Agent 自主工作协议](#ai-agent-自主工作协议) |
| 判断生产与临床边界 | [当前状态与交付边界](#当前状态与交付边界)、[安全边界](#不可突破的安全与临床边界) |
| 修改迁移前产品 | [Legacy 行为参考](#legacy-行为参考) |

## 当前状态与交付边界

当前 `src/` 已包含：

- 患者 CLI 四组命令：`agent`、`record`、`browse`、`account`；
- 管理 CLI 四组命令：`content`、`agent`、`users`、`auth`；
- `/v1/patient/commands`、`/v1/admin/commands` 等 HTTP 接口；
- Vite + React 患者 Web 薄壳；
- 本地 SQLite，以及 PostgreSQL、S3 兼容对象存储适配器；
- TypeScript、架构门禁、单元/集成测试和浏览器 E2E。

这不表示系统已经可以直接生产上线：

- 临床规则包仍是 `candidate`，未取得临床冻结证据前，正式患者分类输出必须
  硬阻断；
- 正式环境数据供应商和正式身份链路仍是交付阻塞项；
- staging/production 缺少 PostgreSQL、对象存储、真实环境 Provider、密钥等
  必需配置时必须 fail-closed，禁止回退到开发替身；
- 方案浏览默认关闭，部分账号数据权利、提醒和通知能力尚未实现。

不要把“命令已注册”“适配器已存在”或“窄测试通过”写成“链路已完成”或
“生产已就绪”。能力结论必须沿真实调用面验证到存储或外部适配器。

## 事实源与阅读顺序

AI Agent 开工时按以下顺序建立上下文：

1. 当前用户任务和 [`AGENTS.md`](AGENTS.md)：范围、授权、安全和提交规则；
2. 当前代码、测试、CLI `--help`、两个 `package.json` 与
   [CI 配置](.github/workflows/ci.yml)：可执行事实；
3. [`src/README.md`](src/README.md) 与
   [`docs/plan/`](docs/plan/)：交付契约和设计意图；
4. `legacy/`：迁移前行为与验收参考，不是新实现可复用的内部依赖；
5. `docs/reviews/`、`state/memory/` 和其他过程资料：线索，不是无需复核的现状。

设计文档、报告中的文件行号和完成度会随基线漂移。实施前应在当前 `HEAD`
重新定位证据；判断“是否实现”时优先执行命令或测试，而不是只搜索 TODO。

## 仓库地图

| 路径 | 角色 | Agent 边界 |
| --- | --- | --- |
| `src/kernel/` | 结果、错误、协议、凭据、加密等基础契约 | 保持框架无关 |
| `src/modules/` | 患者、管理、Agent、临床规则等业务模块 | 不依赖 CLI、HTTP、Web 或基础设施实现 |
| `src/app/` | 应用编排与组合根 | 基础设施装配集中在这里 |
| `src/infrastructure/` | SQLite、PostgreSQL、S3、模型等适配器 | 不把实现细节泄漏回业务契约 |
| `src/cli/`、`src/http/` | 患者/管理 CLI 与 HTTP 适配层 | 调用应用服务，不复制业务规则 |
| `src/web/` | 患者 Web 薄壳 | 通过命令协议交互，前端不持有业务真相 |
| `src/tests/` | 新实现测试 | 源文件为 `*.test.ts`，构建后执行 |
| `legacy/` | 迁移前完整产品 | 只作行为参考；改动时使用其独立门禁 |
| `vault/truth/` | 私密项目权威资料与报价范围 | 最小必要读取，禁止公开、复制或提交 |
| `scripts/`、`.githooks/` | worktree、Git 钩子与结构治理 | 远端写操作仍受授权边界约束 |
| `state/memory/` | 经复核的跨任务模式与持续指标 | 按关键词读取，随仓库同步 |

不要编辑或提交生成物、本地状态和任务目录，包括 `src/dist/`、
`src/.local/`、`legacy/dist/`、`legacy/.vinext/`、`legacy/.wrangler/`、
`legacy/node_modules/`、`src/node_modules/` 和 `.worktrees/`。

## 环境与快速开始

需要 macOS/Linux 和 Node.js `22.13.0` 或更新版本；仓库的 `.nvmrc` 固定为
`22.13.0`。首次克隆先在仓库根目录安装本地 Git 防误推钩子：

```bash
nvm use
bash scripts/install-git-hooks.sh
```

### 当前主实现：`src/`

```bash
cd src
npm ci
npx playwright install chromium   # 首次运行浏览器 E2E 时需要
npm run check
```

`npm run check` 依次执行类型检查、架构门禁、生产构建、Node 测试和浏览器
E2E。启动本地患者 Web/HTTP 服务：

```bash
cd src
KANGMIN_APP_ENV=local KANGMIN_ALLOW_DEV_SESSION=1 npm run start:http
```

默认访问 `http://127.0.0.1:8787`。本地开发会话不是生产认证；密钥、令牌和
真实患者信息不得写入命令参数、仓库或日志。完整本地会话、远程服务和环境
变量说明见 [`src/README.md`](src/README.md)。

### Legacy 行为参考

```bash
cd legacy
npm ci
npm run check
```

需要人工查看旧产品时，另开终端运行：

```bash
cd legacy
npm run dev
```

`legacy` 的 `npm run check` 包含 lint、生产依赖审计、构建和完整测试。不要把
长驻的 `npm run dev` 与后续检查写成同一串顺序命令。

## AI Agent 自主工作协议

### 1. 开工自检

先读取规则并检查现场，不覆盖用户已有改动：

```bash
git status --short
git branch --show-current
git worktree list
git log -5 --oneline
```

然后确认：

- 任务是只读调研、诊断，还是明确要求实现；
- 目标属于 `src/`、`legacy/`，还是本地文档；
- 当前分支、未提交改动和其他 worktree 是否已有相关工作；
- 范围、非范围、验收标准、风险等级和验证方法是否明确；
- 多 Agent 并行时文件所有权是否互不重叠。

只读调研和诊断可以直接收集证据。`legacy/` 或 `src/` 内需要提交的
feature、fix、refactor 或 automation change，必须先有已确认的 GitHub
Issue。纯设计、调研或说明任务若未修改 `legacy/`/`src/`，只在本地交付，
默认不创建提交或 PR。

### 2. 创建隔离环境

分支名使用 `codex/issue-<编号>-<slug>`。多文件或中高风险代码任务使用：

```bash
bash scripts/worktree-create.sh 123 short-slug
cd .worktrees/issue-123-short-slug
cd src       # 或 cd legacy；仓库根目录没有 package.json
npm ci
```

该脚本会获取 `origin/main` 并从它创建 worktree。数据库迁移、共享类型、权限、
临床规则和核心接口只能有一个集成 owner；并行 Agent 不得同时写同一文件。

### 3. 基于证据实现最小闭环

- 先用 `rg` 定位入口、契约、测试和调用方，再修改最小必要范围；
- 新业务能力先通过 `src/` 的 CLI/应用服务暴露，再由 HTTP/Web 薄层消费；
- 不从 `legacy/` 导入实现，不在 Web、CLI 或模型提示词中复制临床规则；
- 保留用户已有未提交文件，不顺手格式化、恢复、删除或暂存无关改动；
- 失败时先缩小复现、确认根因，再修复；不以放宽断言或伪造数据换取全绿；
- 对能力声明同时核对正常、空态、冲突、高风险和外部依赖降级路径。

### 4. 按影响范围验证

| 改动范围 | 最低本地门禁 |
| --- | --- |
| 仅 `src/` | 相关窄测试，然后 `cd src && npm run check` |
| 仅 `legacy/` | 相关窄测试，然后 `cd legacy && npm run check` |
| 同时影响两套实现 | 两边的 `npm run check` 都运行 |
| UI | 对应门禁 + 真实浏览器路径 + 控制台/网络检查 + 前后截图 |
| 数据库、对象存储、权限、临床、核心接口或部署 | 对应门禁 + 真实适配器/故障路径 + 独立审核 |

本地未设置 `KANGMIN_TEST_DATABASE_URL` 或 `KANGMIN_TEST_S3_*` 时，部分
PostgreSQL/S3 契约测试会跳过，不能将本地全绿表述为这些链路已验证。CI 的
`quality` job 会同时执行 `legacy` 与 `src` 门禁，并提供 PostgreSQL 16、
MinIO 和 Playwright；后续 `image` job 还构建 OCI 镜像、执行容器冒烟、审计
生产依赖并生成 SBOM。

### 5. 差异、提交与 Draft PR

交付前至少核验：

```bash
git diff --check
git status --short
git diff --cached --name-only
```

默认只暂存、提交和推送本任务在 `legacy/`、`src/` 下的相关代码。`README`、
`docs/`、`state/`、`meta/`、计划和过程材料默认只作本地工作
资料；只有用户明确要求将某个范围外文件纳入版本管理时才是例外。当前
pre-commit 钩子会机械阻止范围外路径，遇到明确例外时应停下说明门禁冲突，
不得自行绕过。

代码任务使用短小、聚焦的提交，并按
[PR 模板](.github/PULL_REQUEST_TEMPLATE.md)创建关联 Issue 的 Draft PR。
PR 写明用户可见结果、范围、风险、验证命令和 UI 截图。禁止直接推送
`main`；本地钩子只是防误操作，不能据此声称远端分支保护已经启用。

### 6. 授权终点与收尾

CI、readiness、窄测试或本地验收通过，只证明候选变更满足对应检查，不授权
自动合并、部署、关闭 Issue、声明客户验收或删除资源。

合并后先核验 PR 状态和目标分支最终代码，再运行只读审计：

```bash
bash scripts/worktree-audit.sh .worktrees/issue-123-short-slug
```

只有 PR 已合并、目标分支已核验、worktree 干净、没有未保留的独有成果，且
本地非提交文档已复制回主工作区后，才进入“可申请清理”状态。脚本输出不是
删除授权；未经用户明确确认，不执行 `git worktree remove`，也不删除本地或
远端分支。

### 7. 证据复盘与记忆飞轮

任务结束前判断是否发现了经过复核、可跨任务复用的新模式或持续指标：

- 只按当前任务关键词读取 `state/memory/MEMORY.md` 中索引的相关文件，不要为
  开工自动加载整个模式库；
- 新模式必须有可重复的触发条件、做法、边界和代码/测试证据，去重后才追加；
- 指标必须记录日期、口径、基线和证据，能在后续任务中持续观测；
- 当前状态、一次性测试数字、临时待办和未经复核的猜测不进入长期记忆；
- 强制安全规则应进入 `AGENTS.md` 或正式 runbook，不只保存在经验笔记；
- `state/memory/` 属于仓内项目记忆；新增内容仍须按本次任务范围决定是否提交。

## 不可突破的安全与临床边界

- 不提交或公开令牌、密码、`.env*`、患者身份/健康信息或客户私密资料；
- `vault/truth/` 仅在任务确需时最小范围读取，不复制到 `public/`、Issue、
  PR、日志、截图或模型输出；
- 固定规则链先做安全门禁、适用性、分级与证型判断；模型只提取候选、解释
  已确定结果和检索已批准知识，不能新增、篡改或猜测诊断；
- `unknown` 不等于 `no`；高风险、答案冲突、信息不足、无命中和未批准规则
  必须 fail-closed；
- 当前 `clinical-rules-draft-v0` 为 `candidate`，只允许模拟测试链路使用；
- staging/production 不得回退到 SQLite、本地素材、开发会话或测试环境
  Provider；缺配置必须明确失败；
- 不随意修改 `.openai/hosting.json` 标识，不运行未获授权的部署、合并、分支
  保护配置或破坏性操作；
- 不编辑生成目录，不用删除/重置解决脏工作区，不把无关用户改动带入交付。

## 何时必须暂停并请求方向

在安全范围内应先自行查证和排障；出现以下情况才暂停：

- 代码任务没有已确认 Issue，或范围/验收存在会改变实现方向的冲突；
- 需要扩大到未授权系统、仓库、数据、人员或外部写操作；
- 需要合并、部署、关闭 Issue、清理 worktree/分支或执行不可恢复操作；
- 需要接触未提供的凭据、未脱敏患者数据，或可能泄露客户资料；
- 临床规则、权限、数据库迁移或核心接口缺少唯一 owner/审批证据；
- 当前证据互相冲突，且继续假设会产生医疗、安全、数据或生产风险。

## 完成定义

一个代码任务只有同时满足以下条件才可报告“实现完成”：

- 用户可观察结果符合已确认验收标准；
- 代码、测试、帮助文本和必要文档保持一致；
- 已运行与影响范围匹配的门禁，并如实记录跳过项和已知失败；
- 没有泄露秘密、患者/客户资料，也没有夹带无关改动；
- Draft PR（如任务需要）包含风险与验证证据；
- 合并、部署、Issue 关闭和清理状态分别报告，不把它们混成“已完成”。

## 可核验入口

- [Agent 强制规则](AGENTS.md)
- [新实现交付文档](src/README.md)
- [患者 CLI 架构](docs/plan/004_kangmin-patient-cli-design.md)
- [管理 CLI 架构](docs/plan/005_kangmin-admin-cli-design.md)
- [Task Issue 模板](.github/ISSUE_TEMPLATE/task.yml)
- [Bug Issue 模板](.github/ISSUE_TEMPLATE/bug.yml)
- [Draft PR 模板](.github/PULL_REQUEST_TEMPLATE.md)
- [CI 门禁](.github/workflows/ci.yml)
- [worktree 创建脚本](scripts/worktree-create.sh)
- [worktree 收尾审计](scripts/worktree-audit.sh)
- [临床规则包状态](src/modules/clinical-rules/rule-package.ts)
- [模型输出校验](src/modules/agent/output-validation.ts)
