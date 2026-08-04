# 抗敏先锋 CLI-first 新实现（交付文档）

与 `legacy/` 隔离的新应用核心，通过两个 CLI 交付：患者端 `kangmin`
与管理端 `kangmin-admin`。CLI 可作为远程命令服务的薄客户端；本地 SQLite
模式保留给开发和集成测试。`web/` 是患者薄前端壳（Vite + React 静态构建，
产物由 HTTP 服务托管），只通过 `/v1/patient/commands` 命令协议交互，
当前覆盖 legacy 用户端主界面 demo（症状/档案/暴露/用药记录与安全评估
外壳）；不表示 PostgreSQL、对象存储或正式身份认证已经完成。

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

### 患者 Web 薄壳（demo）

`web/` 是 Vite + React 静态工程，移植自 legacy 用户端主界面（首页/聊天/
过敏日历/健康档案/过敏原记录/科普/我的 七个 tab），只通过
`POST /v1/patient/commands` 命令协议读写，前端零业务逻辑。
`npm run build` 时 Vite 把产物输出到 `dist/web/`，由 HTTP 服务托管：

```bash
npm run build
KANGMIN_APP_ENV=local KANGMIN_ALLOW_DEV_SESSION=1 node dist/http/server.js
# 打开 http://127.0.0.1:8787（开发会话自动引导；正式登录尚未接入）
```

demo 简化点（均如实呈现，不伪造服务端能力）：安全评估面板只将"危险
信号"组提交确定性安全外壳会话（`agent start/continue` 的 urgentHelp），
其余分组留在本地；聊天自由对话仍是静态演示脚本（未接 `agent exec`）；
健康档案为扁平字段（结构化过敏史与诱因投影无对应命令，显示"暂无"）；
用药按日期记录（无时分）；"学一学"入口暂指向内置科普 tab（/discover
未迁移）；"我的"页为静态演示（account 注册/登录未接入）。

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
| `KANGMIN_PLAN_BROWSE_ENABLED` | 方案浏览开关（`1` 开放，默认关闭；临床规则包冻结前不放开） |
| `KANGMIN_ADMIN_MEDIA_DIR` | 管理端素材目录，默认与数据库同目录的 `admin-media` |
| `KANGMIN_S3_BUCKET` | S3 兼容对象存储桶名；配置后管理端素材/知识文件改用 S3 后端（缺省为本地文件系统后端） |
| `KANGMIN_S3_ENDPOINT` | S3 兼容端点地址（如 MinIO）；缺省走 AWS 默认端点 |
| `KANGMIN_S3_REGION` | S3 区域，默认 `us-east-1` |
| `KANGMIN_S3_ACCESS_KEY_ID` | S3 访问密钥 ID；配置 `KANGMIN_S3_BUCKET` 时必填，缺失 `config_missing` |
| `KANGMIN_S3_SECRET_ACCESS_KEY` | S3 访问密钥；配置 `KANGMIN_S3_BUCKET` 时必填，缺失 `config_missing` |
| `KANGMIN_MEDIA_MAX_BYTES` | 素材文件大小上限（字节），默认 200MB；超限 `validation_failed` |
| `KANGMIN_KNOWLEDGE_MAX_BYTES` | 知识源文件大小上限（字节），默认 50MB；超限 `validation_failed` |

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
browse [--location X]
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

裸 `browse` 首页聚合文章/视频/分类与环境区块：`--location` 指定城市时
环境区块返回当前快照（`status: "ok"`）；未指定标注 `no_location`；数据源
不可用标注 `unavailable` 并带原错误码（不伪造数据，不影响其余区块）。

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
agent continue [session-id] --expected-revision <n> --question urgentHelp --answer yes|no|unknown
                                 缺省 session-id 时续接最近待答会话（需登录）
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
account consent update --type privacy|medical_boundary|health_data|agent_session_save|location
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
PostgreSQL 适配器已实现（见下节）；对象存储两种后端见"对象存储与上传"
一节，生产组合根的存储门禁在运维发布阶段完成。

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

## 对象存储与上传

管理端素材与知识源文件统一走对象存储端口（`modules/system/object-storage-ports.ts`），
对象键约定 `<med_id>/<原始文件名>`，两种后端一致：

- **本地文件系统后端（默认）**：未配置 `KANGMIN_S3_BUCKET` 时启用，服务端
  直写到素材目录（`KANGMIN_ADMIN_MEDIA_DIR`），语义与改造前一致；
  不支持远程直传——远程模式调用 `upload-init` 返回 `capability_unavailable`。
- **S3 兼容后端**：配置 `KANGMIN_S3_BUCKET`（及访问密钥）后启用，
  支持预签名直传；`KANGMIN_S3_ENDPOINT` 可指向 MinIO 等兼容实现。

远程模式下 `content media upload <file>` 与 `agent knowledge add <file>`
由 CLI 在本地编排三步，命令契约与本地模式一致：

1. `content media upload-init`：申请预签名直传票据（扩展名白名单 +
   大小上限 + sha256 形状校验）；同指纹素材已就绪时直接重放，不发新票据；
2. HTTP PUT 直传对象存储：CLI 携带票据签名头直传字节，不经过命令服务，
   服务端不接收客户端本地路径；失败映射可重试的 `service_unavailable`；
3. `content media upload-confirm`：服务端校验对象存在、大小与 sha256
   一致，并读取真实字节做魔数嗅探（类型双校验第二步）；任一失败即标记
   failed、删除对象并返回 `validation_failed`。

`agent knowledge add` 在确认就绪后追加 `agent knowledge add-from-media`
创建知识（与本地 add 同幂等键，同文件重复提交重放原知识）。

类型双校验（扩展名 + 内容魔数）与大小上限全程 fail-closed，本地直写与
远程直传一致执行。客户端 init 后中断的孤儿会话（processing 草稿）由
`content media cleanup-orphans [--older-than <分钟>] --yes` 清理：
删除存储对象并移除草稿行，属高影响操作，未带 `--yes` 返回
`confirmation_required`。

## OCI 镜像与部署契约

`src/Dockerfile` 为多阶段构建：builder 阶段 `npm ci && npm run build`
（TypeScript 只在构建期编译），runner 阶段只携带 `dist/` 与
`npm ci --omit=dev` 产出的生产依赖，以非 root 用户 `node` 运行，
typescript、playwright 等 dev 依赖不进入运行时镜像。

```bash
docker build -t kangmin-cli:latest ./src
docker run --rm -p 8787:8787 \
  -e KANGMIN_APP_ENV=production \
  -e KANGMIN_DATABASE_URL="postgres://..." \
  -e KANGMIN_ENCRYPTION_KEYS="v1:<base64>" \
  -e KANGMIN_S3_BUCKET="..." \
  -e KANGMIN_S3_ACCESS_KEY_ID="..." \
  -e KANGMIN_S3_SECRET_ACCESS_KEY="..." \
  kangmin-cli:latest
```

运行契约：

- 入口 `node dist/http/server.js`，端口 8787（`EXPOSE 8787`）；镜像内
  `HEALTHCHECK` 用 node fetch 打 `GET /live`（slim 镜像不含 curl）。
- 生产必需环境变量：`KANGMIN_APP_ENV=production`、`KANGMIN_DATABASE_URL`
  （PostgreSQL 连接串）、`KANGMIN_ENCRYPTION_KEYS`；素材/知识走 S3 时
  另需 `KANGMIN_S3_BUCKET`、`KANGMIN_S3_ACCESS_KEY_ID`、
  `KANGMIN_S3_SECRET_ACCESS_KEY`（`KANGMIN_S3_ENDPOINT`、
  `KANGMIN_S3_REGION` 可选）。变量语义见上文"本地/集成配置"表。
- 进程以非 root `node` 用户运行；配置 `KANGMIN_DATABASE_URL` 后不再写
  本地 SQLite，根文件系统可按只读（`--read-only`）挂载。缺省 SQLite
  路径 `.local/` 仅供开发，不是生产路径。
- 服务当前监听 127.0.0.1（见 `src/http/server.ts`），容器内健康检查
  直连该地址；对外发布由编排层（同 Pod 代理等）处理。

SBOM 与依赖审计：

```bash
npm run sbom                            # 生成 sbom.cyclonedx.json（CycloneDX，不入库）
npm audit --omit=dev --audit-level=high # 生产依赖高危审计，非零即失败
```

CI 的 `image` 任务（依赖 `quality` 通过）构建镜像、容器内冒烟
（`node dist/cli/kangmin.js --version`）、执行上述生产依赖审计，并把
SBOM 作为 artifact 上传（保留 30 天）。

## 已知限制

- **Agent 正式输出在临床冻结前阻断**：规则包为 candidate，只能用于
  模拟测试（`agent test run`），正式患者输出为固定阻断文案。
- **环境数据接口为测试替身**：`browse environment` 使用
  TestEnvironmentProvider（`KANGMIN_ENV_PROVIDER_MODE` 控制故障模式），
  未接入真实供应商。组合根 fail-closed：仅 `local`/`integration` 或显式
  `KANGMIN_ALLOW_DEV_SESSION=1`（且非 `staging`/`production`）启用测试替身，
  其余环境环境命令返回 `provider_unavailable`（退出码 6），绝不返回假数据。
- **幂等表合并待后续**：患者侧 `idempotency_records` 与管理侧
  `admin_idempotency` 两张表语义已统一（公共 runIdempotentCreate），
  物理合并为 `command_idempotency` 留待迁移 0013 独立发布。
- **account 数据导出/删除/停用与提醒通知明确未实现**（返回
  `capability_unavailable`，不伪造成功）。
- **开发会话不是生产身份**：dev:session / dev:admin-session 仅限本地
  开发，生产模式拒绝。
- 新代码不得导入 `legacy/` 业务模块（架构门禁强制）。
