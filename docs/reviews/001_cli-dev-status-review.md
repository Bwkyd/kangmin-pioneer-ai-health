# 001 CLI 开发完善状态调研报告（2026-08-02）

> 调研方式：5 个分身并行独立核验（设计文档 vs 实现、基础设施、构建测试实跑、HTTP/Web 薄壳）。
> 基线：HEAD = `e74e369 Productionize patient CLI infrastructure (stage 0) (#137)`，`src/` 工作区干净。
> 本报告所有判定均有 `文件:行号` 证据；未实现能力以 `capability_unavailable` / `index_failed` / `not_configured` 如实暴露，未发现伪装成功的实现。

## 总体判定

**约 80% 完成**：骨架生产化、临床与安全红线全部落地、剩余缺口全部如实显式暴露。
`_work/20260805-cli-delivery-status/delivery-status.md` 声称的"全绿"经独立实跑验证**属实**。

## 0. 实跑验证（独立复核，非引用状态文件）

| 命令 | 退出码 | 结论 |
|---|---|---|
| `npm run build`（clean-dist + tsc + copy-web-assets） | 0 | 通过 |
| `node scripts/architecture-check.mjs`（= `npm run lint`） | 0 | `architecture-check: PASS` |
| `node --test dist/tests/*.test.js`（22 个测试文件） | 0 | **180/180 通过**，0 失败 0 跳过 |
| `node scripts/web-browser-e2e.mjs`（Playwright） | 0 | PASS（保存/刷新/修改/跨端冲突/重启持久） |
| `npm run check`（组合全链路） | 0 | 全绿 |
| `node dist/cli/kangmin.js --version` | 0 | `kangmin 0.1.0` |
| `node dist/cli/kangmin-admin.js --help` | 0 | 四组帮助完整 |

dist 与源码同步；`npm link` 全局安装可用（`private: true`，不可 publish）。

## 1. 患者端 `kangmin`（约 80%）

### 1.1 命令树覆盖

- **agent 组**：裸 `kangmin` 交互对话 ✅（kangmin.ts:470-478, 774-842）；`kangmin "<文本>"` 快捷入口 ✅（:615-623）；`agent start`（无 message，确定性安全外壳，需登录）✅（application.ts:350-356）；`agent start --message`（自由对话，匿名可用）✅（:298-311）；`agent continue/resume/sessions list/exec` ✅；`agent feedback` 🚧 只覆盖自由对话，确定性安全会话无反馈入口（:321-332）；`agent conversations list/show` ➕ 代码新增（设计无）；患者侧 `agent test run` ⚠️ 解析残留、恒 `capability_unavailable`（kangmin.ts:572-603, conversation-service.ts:563-568）
- **record 组（~95%）**：overview/profile/symptom/exposure/medication CRUD 全实现 ✅；calendar/trend ✅（record-service.ts:597-666）；🚧 `symptom list --from/--to` 选项可解析但被忽略（application.ts:419-424）
- **browse 组（~90%）**：裸 browse 聚合、article/video list/categories/search/show、plan list/show（双门禁：管理端 enabled + 规则包 approved，sqlite-content-read-repository.ts:247-280）、跨内容 search、environment current/forecast/refresh（测试替身 Provider）✅
- **account 组（~60%）**：login/logout/status/register/profile ✅；consent 🚧 仅 privacy/medical_boundary 两类，缺健康数据/Agent 会话保存/定位授权（account-service.ts:29-36）；privacy ✅；data export/deletion-request/request-status/deactivate、reminder、notification ❌ 整组 `capability_unavailable`（application.ts:775-789，与设计 §9.7"另行确认"一致）
- **全局**：help/doctor/completion zsh/--version ✅（kangmin.ts:844-895）

### 1.2 §17 验收标准

15 条中 14 条 ✅，1 条 🚧（患者端残留 `agent test run` 解析，恒拒绝）。重点项：

- candidate 规则包正式输出阻断 ✅ 且比设计更严：患者侧 verdict 裁剪 stage/severity/syndrome/planId 防侧信道拼装（output-validation.ts:37,129-132; conversation-service.ts:473-508）
- 匿名一次性体验：patientId=null、24h 短保留、登录后绑定需显式 saveConsent，绝不自动绑定（conversation-service.ts:59-62,126-146）
- 写入身份+幂等+版本：创建强制幂等键 + stale_replay；更新/删除 expectedRevision CAS（record-service.ts:76-130）
- 读取失败≠空数据：overview 带 dataRead 字段（record-service.ts:593）
- 未知/冲突/无命中不猜测补齐：全链路 fail-closed（clinical-rule-kernel.ts:180-195,217-231）
- JSON/错误码/退出码稳定：receipt.operationId + meta 契约（result.ts:42-96; errors.ts:44-68）

### 1.3 患者端偏差清单

设计有、代码没有：
1. `kangmin --continue` / `--resume <id>` 顶层快捷方式（kangmin.ts:466 仅处理 --version）
2. `record symptom list --from/--to` 日期过滤
3. consent 类型仅 2 类；agent 启动前无 consent 强制门禁，仅交互壳展示边界文案（kangmin.ts:780-781）
4. 环境失败码缺 `location_permission_denied`/`provider_unconfigured`/`pollen_not_supported`
5. 症状记录缺"记录来源"字段（设计 §7.5）
6. Agent 知识检索/RAG 未建（设计 §10.3，当前无已批准知识，不违规）
7. 凭据用 `KANGMIN_SESSION_TOKEN` 环境变量而非系统安全存储；登录为本地用户名密码（CLI 形态合理偏离）

代码有、设计没有：`account register`、`agent conversations list/show`、结果信封 `receipt.operationId`（超集）。

## 2. 管理端 `kangmin-admin`（约 80%）

### 2.1 命令树覆盖（注册 66/71 ≈ 93%）

| 命令组 | 覆盖 | 判定 |
|---|---|---|
| content article | 7/8 | 🚧 缺 `import` |
| content video / media / category / message | 全 | ✅（category show、message show 为设计外补充） |
| agent status / plan | 全 | ✅ 字段全覆盖，启用校验视频已发布（agent-admin-service.ts:875-888） |
| agent knowledge | 7/9 | 🚧 缺 `preview`、`update`；PDF/DOCX 无解析器如实 `index_failed`，仅 md/txt 可用（:810-819） |
| agent model | 3/3 | 🚧 `model test` 恒 `capability_unavailable`（:737-770，适配器未注入管理端） |
| agent test | 2/2 | 🚧 `test run` 恒 `capability_unavailable`（:779-784） |
| users | 5/5 | 🚧 语义偏差见 D1/D3 |
| auth（含 admins×4） | 9/9 | ✅ |
| 裸运行默认工作台 | 0/1 | ❌ 裸运行只打印 HELP（kangmin-admin.ts:546） |

### 2.2 §15 验收标准

15 条中 11 条 ✅；🚧 3 条（登录✅但默认工作台❌；知识链路完整但 PDF/DOCX 解析未实现；"无启用方案时 AI 不补写"管理端无路径但该语义属运行时，端到端不可验证）；❌ 2 条（`agent test run` 模拟测试；管理 Web——http/server.ts 仅患者 `/v1/commands`，无 admin 路由）。

红线全部落地：密码 stdin 隐藏输入（kangmin-admin.ts:464-517）；凭据 0600 双保险（:441,445）；发布 `--yes` + expectedRevision（admin-application.ts:48-55）；requireOwner 分层 + 末位 owner 保护（admin-auth-service.ts:343-348）；患者账号进不了管理后台（独立 admin_sessions + KANGMIN_ADMIN_TOKEN）；脱敏（手机号 138\*\*\*\*1234、API Key 掩码）+ 敏感读取审计。

### 2.3 管理端偏差清单

- D1（大）：`users sessions` 返回患者**登录会话**（tokenHash 掩码），不是设计 §6.5 的 **Agent 对话会话**（确认信息/证型/方案/最终输出不可查）；`--session <id>` 详情参数未实现
- D2：`users sessions/records` 被 requireOwner 限制，严于设计"普通管理员可查看用户数据"——加固型偏差
- D3：`users records --type medication` 用药名/剂量恒 null（加密列不投影，sqlite-user-admin-repository.ts:187-202）
- D4：视频下架对已启用方案无级联停用，仅在方案启用时点校验
- D5：article `import`、knowledge `preview`/`update` 三条设计命令完全缺失
- D6：错误码命名偏差 `resource_changed`→`version_conflict`（语义等价）

## 3. 内核与基础设施（生产化，无隐藏 stub）

### 3.1 kernel（完整）

errors.ts 23 错误码 + 退出码 0-10 + HTTP 映射三表；result.ts receipt{operationId,requestId} + meta{schemaVersion,requestId,timestamp}；credentials.ts scrypt(N=16384,r=8,p=1) + 防时序枚举 dummy；session-tokens.ts sha256 哈希 + 32B 令牌；encryption.ts 端口 + EncryptedPayload；validation.ts 校验原语。

### 3.2 迁移清单（13 个，database.ts:63-1047）

0001 患者记录基线 / 0002 版本凭证+审计 / 0003 身份（患者账号+管理员独立空间）/ 0004 origin 并行流归账 / 0005 健康正文加密+软删除（明文回填）/ 0006 会话与同意 / 0007 浏览环境方案 / 0008 自由对话（会话/消息/确认事实/候选/决策凭证/反馈）/ 0009 管理控制台 / 0010 admin_sessions 升级 / 0011 幂等 FK 改指 admin_accounts / 0012 admin_sessions FK + 孤儿检测 / **0013 模型 API Key 加密**。

### 3.3 Provider 真实程度

- **模型（患者侧）= 真实 API**：deepseek-model-adapter.ts 真接 api.deepseek.com，key 走 `KANGMIN_DEEPSEEK_API_KEY` 环境变量；未配置/超时/非法 JSON 一律降级结构化问答，不伪造
- **模型（管理侧）= 未接通**：`model test`/`test run` 骨架；API key 走 stdin、密文落库（0013）
- **环境数据 = 测试替身**（test-environment-provider.ts:23 明确不接真实供应商；forecast 不落缓存）；两端 doctor 如实报 not_configured
- **证型/方案注册表 = 已接通规则内核**（syndrome-registry.ts 派生自 SYNDROME_LABELS 唯一真源；sqlite-plan-registry.ts 读 agent_plans 供方案安全评估；:29-31 自述 MSAF-02 与 SAF-05 语义重叠待临床裁决）
- 各 sqlite-*-repository 全量 grep 无 stub/未实现分支

### 3.4 如实占位清单

| 位置 | 说明 |
|---|---|
| application.ts:775-789 | account 数据权利 + reminder/notification 整组 capability_unavailable |
| agent-admin-service.ts:766,779 | 管理端 model test / test run 骨架 |
| agent-admin-service.ts:814-818 | 知识库 PDF/Word 解析未实现，仅纯文本分块 |
| conversation-service.ts:61-62 | BOUND_RETENTION_MS=90 天为占位常量（保留期限未书面确认） |
| rule-package.ts:22 | 规则包 candidate 未冻结，正式输出硬阻断（设计语义） |
| content-aux-service.ts:97,275 | 素材本地文件复制，对象存储后续接入 |
| kangmin.ts:773 | 裸 kangmin 交互为骨架（逐行一问一答） |

### 3.5 文档滞后（README 两处）

1. README:350 写"当前 12 个迁移"，实际 13 个（缺 0013 条目）
2. README:382 称幂等表合并"留待迁移 0013"，实际 0013 已用于 API Key 加密，合并无迁移编号归属

## 4. HTTP / Web 薄壳 / 打包（单功能 + 开发态可用）

- **HTTP（server.ts，363 行，无框架）**：`GET /health`、三个静态资源（严格 CSP）、`POST /dev/session`（仅 local/integration + 显式开关，否则 404，有生产禁用测试）、`POST /v1/commands` 唯一业务入口（64KiB 上限、错误稳定契约）。与 CLI 同组合根（server.ts:324），仅患者端，仅监听 127.0.0.1
- **Web 薄壳（src/web/）**：真接通非 mock，但**只覆盖 record symptom**（TNSS 四项评分增改查、乐观锁冲突提示、幂等键）；底部导航"首页/问助手/我的"均 disabled 占位；无登录 UI——生产环境离开 dev session 即不可用（死路）
- **dev 工具**：双环境闸门（KANGMIN_ALLOW_DEV_SESSION=1 / KANGMIN_ALLOW_DEV_ADMIN_SESSION=1 + env ∈ {local,integration}），安全性合格；create-admin-session.ts 单行压缩风格不符项目规范
- **打包**：bin → dist/cli/*.js（shebang 齐全）；--version/doctor/completion zsh 两端齐备；无 main/files/exports，npm link 可用、publish 不可用
- **验证级别**：http.e2e.test.ts 6 用例 + web-browser-e2e 真浏览器跨端冲突场景，"Web 与 CLI 同一应用服务"实证扎实
- **距"套 legacy 样式薄壳"差距**：agent/browse/account 三域 UI、生产登录页、admin HTTP、REST 资源形态/部署说明、legacy 视觉体系移植

## 5. 剩余工作清单（按优先级）

1. 管理端模型测试链路接通（model test / test run）+ 知识 PDF/DOCX 解析
2. 真实环境数据 Provider 接入
3. account 数据权利（导出/删除/停用）与 reminder/notification 产品决策
4. 幂等表合并迁移（需新编号）+ README 迁移计数修正
5. Web 薄壳四域扩展 + 生产登录 UI + admin HTTP + legacy 样式移植
6. 小项：`--continue/--resume` 快捷方式、symptom 日期过滤、患者端 `agent test run` 解析残留清理、`users sessions` 对话视图、medication 投影解密
