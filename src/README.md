# 抗敏先锋 CLI-first 主实现

`src/` 是抗敏先锋当前主实现。它以同一组应用服务为核心，交付患者 CLI
`kangmin`、管理 CLI `kangmin-admin`、HTTP 命令服务和患者 Web 薄壳，并
提供 SQLite/PostgreSQL、文件系统/S3、DeepSeek 和通义千问等可替换适配器。

本文件描述当前可执行实现，不是生产就绪声明。开始修改前先读仓库根目录的
[`AGENTS.md`](../AGENTS.md) 和 [`README.md`](../README.md)。如果本文与 CLI
`--help`、代码或测试冲突，以当前可执行证据为准，并同步修正文档。

## 快速导航

| 目标 | 入口 |
| --- | --- |
| 安装、验证并启动本地 Web | [快速开始](#快速开始) |
| 查看患者/管理命令 | [交付入口](#交付入口) |
| 调用 HTTP 命令服务 | [HTTP 与 Web](#http-与-web) |
| 配置本地、远程或生产环境 | [运行模式与配置](#运行模式与配置) |
| 理解临床、身份和数据安全 | [安全与临床边界](#安全与临床边界) |
| 判断当前未完成项 | [已知限制与上线阻塞](#已知限制与上线阻塞) |
| 运行测试和 CI 对等检查 | [验证与交付](#验证与交付) |

## 当前状态

| 能力面 | 当前状态 | 边界 |
| --- | --- | --- |
| 患者 CLI | 已实现 `agent`、`record`、`browse`、`account` 四组 | 部分账号数据权利和通知能力明确未实现 |
| 管理 CLI | 已实现 `content`、`agent`、`users`、`auth` 四组 | 高影响命令要求 `--yes` |
| HTTP 命令服务 | 已实现患者/管理分路、协议校验、超时、限流和结构化日志 | 正式身份与真实环境数据供应商尚未接入 |
| 患者 Web | 已实现 Vite + React 薄壳并调用真实命令协议 | 仍是 demo，部分账户和评估 UI 为简化形态 |
| 数据库 | SQLite 本地模式与 PostgreSQL 适配器均已实现 | staging/production 禁止回退 SQLite |
| 对象存储 | 本地文件系统与 S3 兼容后端均已实现 | staging/production 必须使用 S3 后端 |
| 临床规则 | 确定性规则链和输出校验已实现 | 默认规则包 `clinical-rules-v3` 为 `approved`；测试仍覆盖 `candidate` 阻断 |
| 模型 | DeepSeek 负责候选提取/知识问答，千问负责规则结果转译/方案追问，均有降级 | 模型不能改变规则结果、扩展方案或补写诊断 |
| 容器与供应链 | Dockerfile、生产依赖审计和 SBOM 已实现 | 当前生产启动仍受真实 Provider、正式身份和环境配置阻塞 |

不要用“命令可解析”“仓储类存在”或“某个窄测通过”替代真实链路验收。

## 快速开始

需要 Node.js `22.13.0` 或更新版本。以下命令从 `src/` 目录执行：

```bash
cd "/Users/chenqiqiang/work/抗敏先锋AI鼻健康管理系统/src"
npm ci
npx playwright install chromium
npm run check
```

`npm run check` 依次执行：

```text
TypeScript 类型检查
→ 架构依赖门禁
→ TypeScript + Vite 生产构建
→ Node 单元/集成/E2E 测试
→ Playwright 浏览器 E2E
```

构建完成后的入口：

```bash
node dist/cli/kangmin.js --help
node dist/cli/kangmin-admin.js --help
```

### 启动本地患者 Web 与 HTTP 服务

```bash
KANGMIN_APP_ENV=local \
KANGMIN_ALLOW_DEV_SESSION=1 \
npm run start:http
```

默认打开 `http://127.0.0.1:8787`。裸机默认只监听回环地址；Dockerfile 会
显式设置 `KANGMIN_HTTP_HOST=0.0.0.0`。

可用探针：

```bash
curl -s http://127.0.0.1:8787/live
curl -s http://127.0.0.1:8787/ready
```

`/live` 只证明进程存活。`/ready` 会检查数据库、对象存储、加密、环境
Provider 和规则包；任何一项 `failed` 或 `not_configured` 都返回 503。
默认规则包已经启用并通过该项检查；开发环境的 `/ready` 是否为 200 仍取决于
加密、数据库、对象存储和环境 Provider 等其他检查。`/health` 是兼容端点，
不能替代 `/ready` 作为生产就绪证据。

### 建立本地开发会话

患者会话：

```bash
KANGMIN_APP_ENV=local \
KANGMIN_ALLOW_DEV_SESSION=1 \
npm run dev:session -- --subject patient-a

export KANGMIN_SESSION_TOKEN="<上一步输出的 sessionToken>"
```

管理会话：

```bash
KANGMIN_APP_ENV=local \
KANGMIN_ALLOW_DEV_SESSION=1 \
KANGMIN_ALLOW_DEV_ADMIN_SESSION=1 \
npm run dev:admin-session -- --subject owner-a

export KANGMIN_ADMIN_TOKEN="<上一步输出的 adminToken>"
```

开发会话只允许 local/integration。令牌不要写进仓库、命令参数、截图或日志。

## 交付入口

### `kangmin`：患者 CLI

```text
agent    确定性安全会话、自由对话、会话与反馈
record   症状/TNSS、档案、暴露、用药、日历与趋势
browse   已发布文章/视频、搜索、环境快照与受控方案浏览
account  注册、登录、资料、同意与隐私
```

辅助命令：`--version`、`doctor`、`completion zsh`。精确命令、参数和当前
能力声明以以下输出为准：

```bash
node dist/cli/kangmin.js --help
```

关键边界：

- `agent test run` 属于管理端，不是患者命令；
- `browse plan` 默认关闭，临床规则冻结前不得开放；
- `account data export/deletion-request/request-status/deactivate` 以及提醒、
  通知当前返回 `capability_unavailable`；
- CLI 不接受 `patient_id` 或 `user_id`，身份由服务端会话令牌解析。

### `kangmin-admin`：管理 CLI

```text
content  文章、视频、素材、分类与公告
agent    知识、方案、模型设置与模拟测试
users    患者、会话、记录与活动的只读脱敏视图
auth     管理员登录、状态和普通管理员账号管理
```

辅助命令：`help`、`doctor`、`--version`、`completion zsh`。精确命令树：

```bash
node dist/cli/kangmin-admin.js --help
```

密码和模型 API Key 从 stdin 读取，不进入 argv。发布、下架、删除、启用、
停用和孤儿上传清理等高影响操作要求 `--yes`。

### 机器输出

两个 CLI 添加 `--json` 后，stdout 只输出一个 `CommandResult` JSON 对象；
进度和诊断进入 stderr。成功与失败共享 `receipt` 和 `meta`，其中
`requestId` 用于跨 CLI、HTTP、日志和审计关联。

```json
{
  "ok": true,
  "command": "record symptom list",
  "status": "completed",
  "data": {},
  "receipt": {
    "operationId": "<uuid>",
    "requestId": "<uuid>"
  },
  "meta": {
    "schemaVersion": "1",
    "requestId": "<uuid>",
    "timestamp": "<ISO-8601>"
  }
}
```

失败结果使用 `status: "failed"`，并包含 `error.code`、`error.message`、
`error.retryable` 和可选 `error.details`。

## HTTP 与 Web

HTTP 服务同时托管 Vite 构建产物和命令接口：

| 方法与路径 | 用途 |
| --- | --- |
| `GET /`、`GET /assets/*` | 患者 Web 薄壳与静态资源 |
| `GET /live` | 无依赖存活探针 |
| `GET /ready` | 依赖就绪探针 |
| `GET /v1/meta` | 协议、schema、服务版本与 audience |
| `POST /v1/patient/commands` | 患者命令；Bearer 或 HttpOnly 开发 Cookie |
| `POST /v1/admin/commands` | 管理命令；独立 Bearer 管理令牌 |
| `GET /v1/media/<id>` | 已发布内容引用的公开媒体 |
| `POST /dev/session` | 仅显式启用的 local/integration 开发会话 |

`POST /v1/commands` 是兼容患者路由；新客户端应使用版本化的
`/v1/patient/commands`。版本化请求必须包含：

```json
{
  "schemaVersion": "1",
  "command": "record overview",
  "input": {},
  "requestId": "<1 到 120 个字符>"
}
```

服务端校验 schema 与关联号，按登录/上传/普通命令分级限流，并返回同一
`requestId`。结构化请求日志不记录请求体、令牌或健康正文。

### 患者 Web 薄壳

`web/` 是 Vite + React 静态工程，只通过患者命令协议访问业务能力。当前已
连接症状记录、健康档案、暴露、用药、概览、文章/视频和自由对话等真实
命令；无数据时显示空态，不伪造统计。它仍是 demo：部分安全评估分组保留
本地 UI 状态，账户区尚未接完整账号命令，正式身份也未接入。

前端不得复制临床决策树、直接访问数据库或导入基础设施模块。

## 架构与依赖方向

```text
kangmin CLI ───────────────┐
患者 Web → HTTP 命令路由 ──┼→ Application Services → Modules / Ports
kangmin-admin CLI ─────────┤                         ↓
管理 HTTP 命令路由 ─────────┘                    Infrastructure
                                              SQLite / PostgreSQL
                                              Filesystem / S3
                                              DeepSeek / Provider
```

目录职责：

| 路径 | 职责 |
| --- | --- |
| `kernel/` | 结果、错误、协议、验证、凭据、加密端口 |
| `modules/` | 业务领域、服务和端口；不得依赖外层适配器 |
| `app/` | 应用服务、组合根与跨模块编排 |
| `infrastructure/` | SQLite、PostgreSQL、S3、模型、环境和日志适配器 |
| `cli/` | 两个命令行入口和参数/输出适配 |
| `http/` | HTTP、静态资源、探针、限流和请求日志 |
| `web/` | 患者 Web 薄壳 |
| `tests/` | TypeScript 单元、契约、集成与 E2E 测试 |
| `scripts/` | 架构门禁、构建清理、浏览器 E2E 与 SBOM |

`npm run lint` 执行的架构门禁会阻止：

- 任意新代码导入 `legacy/`；
- `modules/` 依赖 infrastructure/CLI/HTTP/Web；
- CLI、HTTP、dev 绕过组合根直连基础设施；
- kernel 反向依赖应用层。

## 运行模式与配置

### 模式矩阵

| 模式 | 数据/存储 | 允许的开发降级 | 远程 CLI |
| --- | --- | --- | --- |
| `local` | 默认 SQLite + 本地素材，也可显式 PostgreSQL/S3 | 允许开发会话、明文开发加密和测试环境 Provider | 可选 |
| `integration` | 与 local 相同，供自动化测试 | 允许受控测试替身 | 可选 |
| `staging` / `production` | 必须 PostgreSQL + S3 + AES 密钥 + 真实环境 Provider | 全部禁止 | CLI 必须配置 HTTPS 服务地址 |

未设置 `KANGMIN_APP_ENV` 时按生产安全语义处理，不会静默进入开发模式。

### 核心与远程 CLI

| 变量 | 语义 |
| --- | --- |
| `KANGMIN_APP_ENV` | `local` / `integration` / `staging` / `production` |
| `KANGMIN_API_BASE_URL` | 远程命令服务根地址；不得含凭据、查询或片段；staging/production 必须 HTTPS |
| `KANGMIN_API_TIMEOUT_MS` | 远程请求超时，默认 15000，范围 100–120000 毫秒 |
| `KANGMIN_SESSION_TOKEN` | 患者令牌 |
| `KANGMIN_ADMIN_TOKEN` | 管理员令牌，与患者令牌隔离 |
| `KANGMIN_DEEPSEEK_API_KEY` | 自由对话模型密钥；缺失时按代码定义降级 |
| `KANGMIN_QWEN_API_KEY` | 规则结果转译与方案后追问密钥；缺失时回退固定模板 |
| `KANGMIN_QWEN_MODEL` | 千问模型名；默认 `qwen3.7-flash` |
| `KANGMIN_ALLOW_DEV_SESSION` | 开发会话/开发降级开关；staging/production 禁止 |
| `KANGMIN_ALLOW_DEV_ADMIN_SESSION` | 仅开发管理员会话脚本使用，且要求 local/integration |
| `KANGMIN_ENV_PROVIDER_MODE` | `fixed` / `unavailable` / `timeout` 测试替身；正式环境禁止 |

设置 `KANGMIN_API_BASE_URL` 后，两个 CLI 先读取 `/v1/meta` 校验协议，再分别
调用患者或管理命令路由。staging/production 未配置服务地址时 CLI 以
`config_missing` 失败，禁止回退到本地数据库。

### 数据、加密与对象存储

| 变量 | 语义 |
| --- | --- |
| `KANGMIN_DB_PATH` | SQLite 路径，默认 `.local/kangmin-mvp.sqlite` |
| `KANGMIN_DATABASE_URL` | PostgreSQL 连接串；配置后使用 PostgreSQL |
| `KANGMIN_ENCRYPTION_KEYS` | AES-256-GCM 密钥链 `v1:<base64>,v2:<base64>`，首项为当前写入版本 |
| `KANGMIN_ADMIN_MEDIA_DIR` | 本地素材目录，默认位于数据库同目录的 `admin-media/` |
| `KANGMIN_S3_BUCKET` | S3 兼容桶；staging/production 必填 |
| `KANGMIN_S3_ENDPOINT` | S3 兼容端点，例如 MinIO；未设时使用 AWS 默认端点 |
| `KANGMIN_S3_REGION` | S3 region，默认 `us-east-1` |
| `KANGMIN_S3_ACCESS_KEY_ID` | S3 访问密钥 ID |
| `KANGMIN_S3_SECRET_ACCESS_KEY` | S3 私密访问密钥 |
| `KANGMIN_S3_FORCE_PATH_STYLE` | 自定义端点寻址方式；腾讯云 COS 设 `0`，MinIO 通常设 `1` |
| `KANGMIN_S3_SIGN_CHECKSUM` | 是否签入 AWS SHA-256 头；COS 可设 `0`，确认阶段仍下载重算 |
| `KANGMIN_MEDIA_MAX_BYTES` | 素材大小上限，默认 200 MiB |
| `KANGMIN_KNOWLEDGE_MAX_BYTES` | 知识文件大小上限，默认 50 MiB |
| `KANGMIN_WECHAT_ENABLED` | `1` 启用微信登录；Web 确认阶段保持 `0` |
| `KANGMIN_WECHAT_APP_ID` | 微信小程序 AppID；启用微信登录时必须与 AppSecret 同时配置 |
| `KANGMIN_WECHAT_APP_SECRET` | 微信小程序 AppSecret，仅服务器密钥注入，禁止写入仓库或前端 |
| `KANGMIN_ENVIRONMENT_ENABLED` | `0` 表示按交付范围关闭环境数据；其他值要求 production 注入真实 Provider |

加密解析顺序：

1. 有 `KANGMIN_ENCRYPTION_KEYS`：健康正文使用 AES-256-GCM；
2. 无密钥但明确为 local/integration：允许 `plaintext-dev` 开发降级；
3. 其他情况：`config_missing`，拒绝启动；
4. 旧库存在待回填明文但没有密钥：拒绝迁移，不静默丢失或继续明文运行。

### HTTP 运行参数

| 变量 | 默认值 | 语义 |
| --- | --- | --- |
| `PORT` | `8787` | 监听端口 |
| `KANGMIN_HTTP_HOST` | `127.0.0.1` | 裸机监听地址；容器设为 `0.0.0.0` |
| `KANGMIN_HTTP_BODY_LIMIT` | 1 MiB | 生产入口请求体上限，字节 |
| `KANGMIN_HTTP_TIMEOUT_MS` | 30000 | 单请求超时 |
| `KANGMIN_RATE_LIMIT_STRICT_PER_MINUTE` | 10 | 开发会话与登录类命令每 IP/分钟 |
| `KANGMIN_RATE_LIMIT_UPLOAD_PER_MINUTE` | 30 | 上传类命令每 IP/分钟 |
| `KANGMIN_RATE_LIMIT_COMMANDS_PER_MINUTE` | 120 | 普通命令每 IP/分钟 |

### 测试服务

| 变量 | 用途 |
| --- | --- |
| `KANGMIN_TEST_DATABASE_URL` | PostgreSQL 契约测试；需要可创建临时数据库 |
| `KANGMIN_TEST_S3_ENDPOINT` | S3 契约/E2E 的 MinIO 或兼容端点 |
| `KANGMIN_TEST_S3_BUCKET` | S3 测试桶 |

未设置这些变量时，对应可选契约测试会 skip；本地 `npm run check` 全绿不能
表述为 PostgreSQL/S3 已在本机完成真实验证。CI 会提供 PostgreSQL 与 MinIO。

## 数据与上传

### SQLite 与 PostgreSQL

- SQLite 是 local/integration 默认，启用 WAL、外键、busy 重试和版本化
  `schema_migrations`；旧库按序升级；
- PostgreSQL 适配患者和管理端仓储，使用版本化事务迁移和 advisory lock；
- 两种实现共享端口契约，覆盖身份隔离、幂等、revision/CAS、软删除、加密和
  审计语义；
- 不在 README 固定迁移数量或测试数量；需要现状时读取
  `infrastructure/database.ts`、`infrastructure/postgres/pg-migrations.ts`
  和当前测试输出；
- 配置 PostgreSQL 不会自动迁移已有 SQLite 数据，生产数据迁移需独立方案。

### 本地文件系统与 S3

管理素材和知识文件统一使用对象存储端口：

- local/integration 未配置 S3 时使用本地素材目录；
- 配置 S3 后支持预签名直传；
- 远程 `content media upload` 和 `agent knowledge add` 使用
  `upload-init → PUT → upload-confirm`；命令服务不接收客户端本地路径；
- 扩展名、大小、对象存在性、SHA-256 和内容魔数双重校验均 fail-closed；
- 中断产生的孤儿上传需显式执行带 `--yes` 的清理命令；
- staging/production 缺少 S3 桶或凭据时拒绝启动。

## 安全与临床边界

- 患者与管理员令牌完全隔离；患者可使用 Bearer 或 HttpOnly 开发 Cookie，
  管理路由只接受独立 Bearer 令牌；
- CLI 不接受客户端身份或角色字段；服务端从会话解析主体和权限；
- 密码、模型 API Key 和健康正文不进入 argv 或结构化请求日志；
- 管理 CLI 本地凭据文件权限为 `0600`，并绑定其签发的本地/远程环境；
- 健康正文按字段加密落库，列表、日志和管理员只读视图按最小必要原则输出；
- 固定规则链先执行安全门禁、适用性、严重度和证型判断；
- 模型只能提取候选、解释规则结果和检索已批准知识，不能新增或覆盖诊断；
- `unknown` 不等于 `no`；高风险、冲突、信息不足、无命中和未批准规则均
  fail-closed；
- 默认 `clinical-rules-v3` 当前为 `approved`，可以输出确定性分类结果；测试注入的
  `candidate` 包仍必须返回规则包未启用阻断；
- 不把 `vault/truth/` 的内容复制到 Web 公共资源、日志、Issue、PR
  或响应。

## 协议与退出码

患者端与管理端共享 `kernel/errors.ts` 定义的错误码和退出码：

| 退出码 | 类别 | 示例 |
| --- | --- | --- |
| 0 | 成功 | — |
| 1 | 内部错误 | `internal_error` |
| 2 | 命令/JSON/请求体错误 | `command_invalid`、`invalid_json`、`payload_too_large` |
| 3 | 资源不存在 | `resource_not_found` |
| 4 | 版本、日期、幂等或重放冲突 | `version_conflict`、`idempotency_conflict` |
| 5 | 确认、同意、配置、信息或协议前置条件 | `confirmation_required`、`consent_required`、`config_missing`、`protocol_incompatible` |
| 6 | 能力、存储、供应商或网络不可用 | `capability_unavailable`、`storage_unavailable`、`service_unavailable` |
| 7 | 业务输入校验失败 | `validation_failed` |
| 8 | 安全规则阻断 | `safety_blocked` |
| 9 | 未登录或权限不足 | `authentication_required`、`permission_denied` |
| 10 | 批量操作部分失败 | `batch_partial_failure` |

HTTP 状态与 CLI 退出码分别映射；例如协议不兼容为 HTTP 426/CLI 5，认证失败
为 HTTP 401/CLI 9。是否可安全重试只看 `error.retryable`，不能仅按状态码猜测。

## 验证与交付

### npm 脚本

| 命令 | 内容 |
| --- | --- |
| `npm run typecheck` | Node 与 Web TypeScript 类型检查，不生成产物 |
| `npm run lint` | 架构依赖门禁 |
| `npm run build` | 清理 `dist/`，编译 TypeScript，构建 Web |
| `npm test` | build + `dist/tests/*.test.js` + 浏览器 E2E |
| `npm run check` | typecheck + lint + test |
| `npm run start:http` | build 后启动 HTTP/Web 服务 |
| `npm run sbom` | 生成不入库的 CycloneDX SBOM |

修改代码时先跑相关窄测试，再跑完整门禁。构建后可执行单个测试：

```bash
npm run build
node --test dist/tests/<name>.test.js
```

CI 的 `quality` job 还会提供 PostgreSQL 16、MinIO 和 Playwright，执行全部
`src` 门禁；仓库级 CI 同时检查 `legacy`。后续 `image` job 构建 OCI 镜像、
执行容器 CLI 冒烟、审计生产依赖并上传 SBOM。

### OCI 镜像

```bash
docker build -t kangmin-cli:local .
docker run --rm --entrypoint node kangmin-cli:local \
  dist/cli/kangmin.js --version
```

Dockerfile 使用多阶段构建，运行阶段只保留 `dist/` 与生产依赖，以非 root
`node` 用户运行，并为 `/live` 配置 HEALTHCHECK。

镜像能构建和 CLI 冒烟通过，不表示当前服务可以 production 启动。不要复制
一组占位生产变量后宣称部署完成；必须先解决下一节的真实 Provider、正式身份
和正式身份、环境配置阻塞，并用 `/ready` 与真实外部依赖验收。

## 已知限制与上线阻塞

- **真实环境数据供应商未接入**：local/integration 使用测试替身；
  staging/production 组合根检测到替身或不可用 Provider 时拒绝启动；
- **正式身份未接入**：当前有本地账号/会话和开发会话，但没有完成生产身份
  提供方与患者 Web 登录闭环；
- **患者 Web 仍是 demo**：部分安全评估和账户 UI 尚未完整映射命令；
- **方案浏览采用双门禁**：默认规则包已通过规则门禁，但后台方案仍须为 `enabled`
  才能在患者端显示；注入 `candidate` 包时仍关闭；
- **部分账号能力未定义完成**：数据导出、删除请求状态、停用、提醒与通知返回
  `capability_unavailable`；
- **生产不能回退**：缺 PostgreSQL、S3、AES 密钥、真实环境 Provider，或出现
  开发会话/测试 Provider 配置时，staging/production 必须失败；
- **SQLite 数据不会自动搬迁到 PostgreSQL**：上线迁移需单独设计、演练和授权。

## 可核验源码入口

- [`package.json`](package.json)：构建、测试与运行脚本
- [`cli/kangmin.ts`](cli/kangmin.ts)：患者 CLI 帮助和命令解析
- [`cli/kangmin-admin.ts`](cli/kangmin-admin.ts)：管理 CLI 帮助和命令解析
- [`http/server.ts`](http/server.ts)：HTTP 路由、探针、限流与日志
- [`app/composition-root.ts`](app/composition-root.ts)：患者组合根与生产门禁
- [`app/admin-composition-root.ts`](app/admin-composition-root.ts)：管理组合根
- [`kernel/protocol.ts`](kernel/protocol.ts)：远程命令协议
- [`kernel/errors.ts`](kernel/errors.ts)：错误码、HTTP 状态和 CLI 退出码
- [`modules/clinical-rules/rule-package.ts`](modules/clinical-rules/rule-package.ts)：规则包状态与来源
- [`modules/agent/output-validation.ts`](modules/agent/output-validation.ts)：模型输出校验
- [`scripts/architecture-check.mjs`](scripts/architecture-check.mjs)：依赖方向门禁
- [`tests/`](tests/)：当前行为证据
- [仓库 CI](../.github/workflows/ci.yml)
- [患者 CLI 架构](../docs/plan/001_kangmin-patient-cli-design.md)
- [管理 CLI 架构](../docs/plan/002_kangmin-admin-cli-design.md)

`dist/`、`.local/`、`node_modules/` 和 `sbom.cyclonedx.json` 是生成或本地内容，
不得编辑或提交。
