# 抗敏先锋 CLI-first 新实现（交付文档）

与 `legacy/` 隔离的新应用核心，通过两个 CLI 交付：患者端 `kangmin`
与管理端 `kangmin-admin`。CLI 可作为远程命令服务的薄客户端；本地 SQLite
模式保留给开发和集成测试。当前只交付 CLI，不包含前端套壳，也不表示
PostgreSQL、对象存储或正式身份认证已经完成。

## 产品概述

### kangmin（患者 CLI，四组命令）

```text
agent    确定性安全会话（结构化问答）+ 自由对话管线
record   管理自己的健康记录（症状/TNSS、档案、暴露、用药）
browse   浏览环境与已发布内容（文章、视频、通用方案、环境快照）
account  管理账号、授权和设置（注册/登录/同意/隐私）
```

辅助命令：`--version`、`doctor`（数据库/存储/密钥配置检查）、
`completion zsh`。

### kangmin-admin（管理 CLI，四组命令）

```text
content  管理文章、视频、素材和公告（编辑、预览、发布、下架）
agent    管理知识库、调理方案、模型和模拟测试
users    只读查看患者用户、会话和健康记录（脱敏）
auth     登录并管理普通管理员账号
```

辅助命令：`help`、`doctor`、`--version`、`completion zsh`。

## 快速开始

需要 Node.js 22.13 或更新版本。

```bash
cd "/Users/chenqiqiang/work/抗敏先锋AI鼻健康管理系统/src"
npm ci
npm run check        # typecheck + 架构门禁 + 单元/集成测试 + 浏览器 e2e
```

`npm run check` 全绿后，`dist/cli/kangmin.js` 与 `dist/cli/kangmin-admin.js`
即为可执行入口（也可 `npm link` 后用 `kangmin` / `kangmin-admin` 直跑）。

### 远程命令服务（预发/生产必选）

两个 CLI 使用同一服务地址，但访问相互隔离的版本化路由：

```text
GET  /v1/meta
POST /v1/patient/commands
POST /v1/admin/commands
```

```bash
export KANGMIN_API_BASE_URL="https://api.example.com"
export KANGMIN_API_TIMEOUT_MS="15000" # 可选，100–120000 毫秒
export KANGMIN_SESSION_TOKEN="<opaque patient token>"
# 管理 CLI 使用独立的 KANGMIN_ADMIN_TOKEN，患者令牌不能调用管理路由
```

设置 `KANGMIN_APP_ENV=staging` 或 `production` 时，如果没有
`KANGMIN_API_BASE_URL`，CLI 会以 `config_missing` 失败，禁止静默回退到
本地数据库。每次命令先校验 `/v1/meta` 的协议与 schema 版本；不兼容返回
`protocol_incompatible`，网络不可达返回可重试的 `service_unavailable`。

### 本地/集成配置（fail-closed 语义）

| 环境变量 | 说明 |
| --- | --- |
| `KANGMIN_ENCRYPTION_KEYS` | AES-256-GCM 密钥链 `"v1:<base64>,v2:<base64>"`，首个为当前版本；配置后健康正文加密落库 |
| `KANGMIN_APP_ENV` | `local` / `integration` / `staging` / `production`；显式预发/生产禁止本地回退 |
| `KANGMIN_API_BASE_URL` | 远程命令服务根地址；预发/生产 CLI 必填，不得含凭据、查询或片段 |
| `KANGMIN_API_TIMEOUT_MS` | 远程请求超时毫秒数，默认 15000，范围 100–120000 |
| `KANGMIN_ALLOW_DEV_SESSION` | 开发降级开关（`1` 启用），显式 `staging`/`production` 时失效 |
| `KANGMIN_DB_PATH` | 数据库文件路径，默认 `src/.local/kangmin-mvp.sqlite` |
| `KANGMIN_DATABASE_URL` | PostgreSQL 连接串；配置后组合根使用 PostgreSQL 存储（自动执行版本化迁移），缺省保持 SQLite |
| `KANGMIN_SESSION_TOKEN` | 患者会话令牌（CLI 不接收 `patient_id`/`user_id`） |
| `KANGMIN_ADMIN_TOKEN` | 管理员令牌（与患者令牌分离；登录后也可写入本地凭据文件） |
| `KANGMIN_DEEPSEEK_API_KEY` | 模型 API 密钥；未配置时自由对话降级为结构化问答 |
| `KANGMIN_ENV_PROVIDER_MODE` | 测试替身故障模式 `fixed`/`unavailable`/`timeout`（仅测试） |
| `KANGMIN_ADMIN_MEDIA_DIR` | 管理端素材目录，默认与数据库同目录的 `admin-media` |

加密策略（组合根强制，测试锁定）：

1. 配置了 `KANGMIN_ENCRYPTION_KEYS` → AES-256-GCM，健康正文加密落库；
2. 未配置密钥，且 `KANGMIN_APP_ENV` 为 `local`/`integration`，或显式
   `KANGMIN_ALLOW_DEV_SESSION=1`（且非 `staging`/`production`）→
   明文开发降级（`plaintext-dev` 版本，生产语义下读取会被拒绝）；
3. 其余任何环境（含默认）→ 启动失败 `config_missing`（退出码 5），
   绝不在缺少密钥时明文启动。检测到旧明文数据但无密钥时同样拒绝启动。

### 建立本地开发会话

患者会话：

```bash
KANGMIN_ALLOW_DEV_SESSION=1 npm run dev:session -- --subject patient-a
# 输出 sessionToken；放入环境变量，不要写入命令参数、仓库或日志
export KANGMIN_SESSION_TOKEN="<opaque token>"
```

管理会话：

```bash
KANGMIN_APP_ENV=local \
KANGMIN_ALLOW_DEV_ADMIN_SESSION=1 \
npm run dev:admin-session -- --subject owner-a
# 或正式引导：auth admins add --role owner（密码从 stdin）+ auth login
export KANGMIN_ADMIN_TOKEN="<opaque admin token>"
```

开发会话不是生产认证。生产模式即使设置开关也拒绝创建开发会话。

## 命令手册

### kangmin（患者）

```text
kangmin                         启动交互式对话（体验版，匿名可用）
kangmin agent                   确定性安全会话（结构化问答，需登录）
kangmin record                  管理自己的健康记录
kangmin browse                  浏览环境与已发布内容
kangmin account                 管理账号、授权和设置

辅助命令：
  kangmin --version
  kangmin doctor
  kangmin completion zsh
```

record 命令：

```text
record symptom add|list|show|update|delete
record profile show|update
record exposure add|list|show|update|delete
record medication add|list|show|update|delete
record overview
record calendar --month YYYY-MM
record trend --from YYYY-MM-DD --to YYYY-MM-DD
```

browse 命令：

```text
browse
browse article list [--limit N] [--offset N]
browse article categories
browse article search <query>
browse article show <id>
browse video list [--limit N] [--offset N]
browse video categories
browse video search <query>
browse video show <id>
browse plan list
browse plan show <id>
browse search <query>
browse environment current [--city X]
browse environment forecast [--days N]
browse environment refresh [--city X]
```

列表分页（article list / video list）：默认 limit 20、上限 100，超出上限被
截断而非报错；结果含 limit/offset 字段，便于翻页。

agent 命令（两条管线，路由按输入区分）：

```text
agent start                      确定性安全会话（结构化问答，需登录）
agent start --message <文本>     自由对话管线（匿名可用，登录后确认可保存）
agent exec <文本> [--conversation <id>] [--save-consent]
                                 非交互自由对话（--json 机器集成）
agent conversations list         自由对话会话列表
agent conversations show <id>    自由对话会话详情
agent continue <session-id> --expected-revision <n> --question urgentHelp --answer yes|no|unknown
agent resume <session-id>        恢复确定性安全会话
agent sessions list|show         确定性安全会话列表/详情
agent feedback <id> --rating helpful|unhelpful [--reason <文本>]
agent test run --answer <field>=<state> 模拟链路（只验证不修改）
```

account 命令：

```text
account register --username <用户名> [--nickname <昵称>]
account login --username <用户名>
account status
account logout
account profile show
account profile update [--nickname <昵称>] --expected-revision <n>
account consent show
account consent update --type privacy|medical_boundary
    --decision granted|withdrawn --policy-version <版本> --request-id <ID>
account privacy
account data export|deletion-request|request-status|deactivate
    （本版本明确未实现）
account reminder|notification
    （本版本明确未实现）
```

### kangmin-admin（管理）

```text
kangmin-admin <命令组> <子命令> [选项]

辅助命令：
  kangmin-admin help
  kangmin-admin doctor
  kangmin-admin --version
  kangmin-admin completion zsh
```

content 命令：

```text
content article  list|show|create|update|preview|publish|unpublish
content video    list|show|create|update|preview|publish|unpublish
content media    list|show|upload <file>|disable|delete
content category list|show|create|update|disable
content message  list|show|create|update|publish|unpublish
```

agent 命令：

```text
agent status
agent knowledge list|show|add <file>|index|enable|disable|search-test <query>
agent plan      list|show|create|update|preview|enable|disable|mappings
agent model     show|update|test
agent test      run|case <case-id>
```

users 命令：

```text
users list|show|sessions|records|activity
```

auth 命令：

```text
auth login --username <u>      密码从 stdin 读取（隐藏输入）
auth status|whoami             当前登录状态与身份
auth admins list|add|enable|disable
auth logout                    撤销当前会话
```

发布/下架/删除/停用/启用等高影响操作需要 `--yes` 显式确认。

## JSON 契约

两个 CLI 加 `--json` 后 stdout 只输出一个 JSON 对象。所有响应共享
`receipt`（操作凭证）与 `meta`（schema 版本/请求关联）字段。

成功响应：

```json
{
  "ok": true,
  "command": "record symptom add",
  "status": "completed",
  "data": {
    "id": "4c1d4f9a-...",
    "localDate": "2026-07-31",
    "nasalCongestion": 2,
    "nasalItching": 1,
    "sneezing": 3,
    "runnyNose": 2,
    "tnssTotal": 8,
    "revision": 1
  },
  "receipt": {
    "operationId": "c3a1f0b0-...",
    "requestId": "a2e0d7c5-..."
  },
  "meta": {
    "schemaVersion": "1",
    "requestId": "a2e0d7c5-...",
    "timestamp": "2026-07-31T10:00:00.000Z"
  }
}
```

失败响应：

```json
{
  "ok": false,
  "command": "record symptom add",
  "status": "failed",
  "error": {
    "code": "version_conflict",
    "message": "记录已被其他操作更新，请刷新后重试",
    "retryable": true
  },
  "receipt": {
    "operationId": "c3a1f0b0-...",
    "requestId": "a2e0d7c5-..."
  },
  "meta": {
    "schemaVersion": "1",
    "requestId": "a2e0d7c5-...",
    "timestamp": "2026-07-31T10:00:00.000Z"
  }
}
```

`doctor` 的 `data` 为 `{ "checks": [{ "name", "status", "message" }], "healthy" }`，
healthy 时退出码 0，否则 6。

### 退出码表（0–10 全表）

| 退出码 | 语义 | 错误码 |
| --- | --- | --- |
| 0 | 成功 | — |
| 1 | 内部错误 | `internal_error` |
| 2 | 命令/输入错误 | `command_invalid`、`invalid_json`、`payload_too_large` |
| 3 | 资源不存在 | `resource_not_found` |
| 4 | 状态/版本/幂等冲突 | `version_conflict`、`date_conflict`、`idempotency_conflict`、`stale_replay` |
| 5 | 前置条件或协议不兼容 | `confirmation_required`、`config_missing`、`more_information_required`、`protocol_incompatible` |
| 6 | 远程服务、外部数据源或存储不可用 | `service_unavailable`、`capability_unavailable`、`storage_unavailable`、`provider_unavailable`、`provider_timeout`、`location_unavailable`、`projection_pending` |
| 7 | 输入校验失败 | `validation_failed` |
| 8 | 安全规则阻断 | `safety_blocked` |
| 9 | 未登录或权限不足 | `authentication_required`、`permission_denied` |
| 10 | 批量操作部分失败 | `batch_partial_failure` |

错误响应中的 `error.retryable` 表示该错误是否可安全重试（如存储瞬时占用为
true，版本冲突/校验失败为 false）。

### 错误码清单

患者端与管理端共享同一套错误码（见 `src/kernel/errors.ts`），共 25 个：

```text
command_invalid / invalid_json / payload_too_large
resource_not_found
version_conflict / date_conflict / idempotency_conflict / stale_replay
confirmation_required / config_missing / more_information_required / protocol_incompatible
capability_unavailable / storage_unavailable
service_unavailable / provider_unavailable / provider_timeout / location_unavailable / projection_pending
validation_failed / safety_blocked
authentication_required / permission_denied
batch_partial_failure / internal_error
```

## 安全边界

- **密码不进 argv**：register/login（患者）与 auth login/admins add（管理）
  的密码从 stdin 读取，交互终端隐藏回显；密码不会出现在命令行参数、历史
  或日志中，非交互未提供时明确失败且不阻塞等待。
- **身份服务端解析**：CLI 不接受 `patient_id`/`user_id`/`admin_id`/`role`；
  患者身份从 `KANGMIN_SESSION_TOKEN`、管理员身份从 `KANGMIN_ADMIN_TOKEN`
  或本地凭据文件解析。客户端提交身份字段返回 `permission_denied`。
- **健康正文加密**：症状、档案、暴露、用药正文经 AES-256-GCM 加密落库
  （库内不存明文）；无密钥且非开发环境时启动失败（fail-closed）。
- **输出不含敏感信息**：患者 `account login` 的 human 模式（无 `--json`）
  把会话令牌只写入 stderr（stdout 显示固定提示，不含令牌）；
  `--json` 模式保留 `data.token` 供机器集成读取后写入
  `KANGMIN_SESSION_TOKEN`（脚本勿把该输出落日志）；管理端 `auth login`
  成功后令牌写入 0600 凭据文件并从响应中删除；users 只读投影对手机号
  等标识脱敏（保留前 3 后 4），绝不返回完整手机号或用户名；健康正文
  只经加密落库，不进日志与脱敏视图。
- **临床红线**：临床规则包为 candidate，正式患者输出在临床冻结前硬阻断
  （Agent 不输出证型、穴位、疗程或调理方案）；`unknown`、冲突、无命中
  和信息不足不会被猜测补齐。
- **读取失败与空数据区分**：存储/模型不可用映射为 `storage_unavailable` /
  `provider_unavailable`（retryable 语义），绝不伪装成空数据。

## 本地/集成数据库

以下 SQLite 能力只描述当前本地和集成运行模式，不是生产存储验收结论。
对象存储适配器仍属于后续阶段；PostgreSQL 适配器已实现（见下节），
生产组合根强制 PostgreSQL 的门禁在运维发布阶段完成。

- 单文件 SQLite（默认 `src/.local/kangmin-mvp.sqlite`），WAL 模式、
  外键开启、busy 重试。
- 版本化迁移账本 `schema_migrations`，当前 12 个迁移：

```text
0001_patient_record_baseline      患者、会话、症状/TNSS、幂等、档案
0002_system_ledger                系统表（版本凭证/审计事件）
0003_identity                     患者账号表
0004_origin_main_tables           内容/管理员/幂等/agent 会话原始表
0005_record_encryption_soft_delete 健康记录加密化 + 软删除
0006_account_sessions_and_consents 本地账号会话与同意记录
0007_browse_environment_plans     浏览内容/环境缓存/方案
0008_agent_conversations          自由对话会话与轮次
0009_admin_console                管理控制台表（文章/视频/素材/分类/知识/方案/模型）
0010_admin_sessions_upgrade       管理员会话表升级
0011_admin_idempotency_fk         管理员幂等表外键归位
0012_admin_sessions_fk            旧库管理员会话外键改指 admin_accounts
```

- **升级路径**：旧库打开时自动按序执行未应用迁移（IF NOT EXISTS 无损
  升级）；加密类迁移对旧明文数据做加密回填，检测到待回填明文但无密钥时
  抛 `config_missing`，绝不静默丢失数据（legacy-upgrade 测试锁定）。
- 创建要求幂等键（`--idempotency-key`），同键重放返回原结果（含删除后
  重放的 `stale_replay`）；更新要求 `expectedRevision`。

## PostgreSQL 存储

配置 `KANGMIN_DATABASE_URL` 后，患者与管理端组合根使用 PostgreSQL
（`pg` 驱动），SQLite 路径完全保留为本地/集成默认：

- 基线迁移 `0001_baseline` 建立与 SQLite 迁移链终态等价的 35 张表
  （TEXT 时间戳、INTEGER 布尔、部分唯一索引语义一致）；生产从空库
  初始化，不迁移任何 SQLite 数据。
- 迁移经 advisory lock 互斥、逐版本事务执行并写入 `schema_migrations`
  账本；数据库出现比代码更新的未知版本时 fail-closed。
- 全部 14 个仓储端口有 PostgreSQL 适配器，与 SQLite 实现跑独立契约
  套件（107 个仓储契约 + 5 个应用级端到端用例）：患者隔离、幂等
  重放、CAS revision、软删除、加密字段、审计强制写语义逐条对齐。
- 并发差异的显式处理：序列化冲突/死锁/锁超时映射为可重试的
  `storage_unavailable`（对齐 SQLite 的 BUSY 映射）；管理端引导与
  最后-owner 守卫用表锁等价 SQLite 的 BEGIN IMMEDIATE 序列化。
- 方案注册表与临床评估调用链已异步化（`PlanRegistryPort.
  findApprovedPlan` 与内核 `evaluate` 返回 Promise），禁止以缓存
  绕过每次评估的最新发布门禁。
- 契约测试需 `KANGMIN_TEST_DATABASE_URL` 指向可建库的 PostgreSQL
  （CI 由 postgres:16 service 提供）；测试在服务器上自建一次性
  隔离库并在结束后删除，未配置时自动 skip。

## 已知限制

- **Agent 正式输出在临床冻结前阻断**：规则包为 candidate，只能用于
  模拟测试（`agent test run`），正式患者输出为固定阻断文案。
- **环境数据接口为测试替身**：`browse environment` 使用
  TestEnvironmentProvider（`KANGMIN_ENV_PROVIDER_MODE` 控制故障模式），
  未接入真实供应商。
- **幂等表合并待后续**：患者侧 `idempotency_records` 与管理侧
  `admin_idempotency` 两张表语义已统一（公共 runIdempotentCreate），
  物理合并为 `command_idempotency` 留待迁移 0013 独立发布。
- **account 数据导出/删除/停用与提醒通知明确未实现**（返回
  `capability_unavailable`，不伪造成功）。
- **开发会话不是生产身份**：dev:session / dev:admin-session 仅限本地
  开发，生产模式拒绝。
- 新代码不得导入 `legacy/` 业务模块（架构门禁强制）。
