# 抗敏先锋 CLI-first 新实现

这里是与 `legacy/` 隔离的新应用核心。Patient Record 已形成完整
命令组，Agent 已建立确定性安全会话的首个纵向闭环。当前仍不能
宣称完整产品、生产身份、D1 数据层或正式医疗闭环已经完成。

## 当前能力

患者公开命令固定为四组：

```text
agent / record / browse / account
```

本 MVP 真实实现：

```text
agent start
agent continue
agent resume
agent sessions list/show
record symptom add/list/show/update/delete
record profile show/update
record exposure add/list/show/update/delete
record medication add/list/show/update/delete
record overview/calendar/trend
browse
browse article list|categories|search|show
browse video list|categories|search|show
```

Agent 当前仅实现安全会话基础：三态回答、`unknown` fail closed、
决策凭证、Record 只读快照、患者隔离与 SQLite 恢复。当前没有获批的
临床规则或方案，因此不输出证型、穴位、疗程或调理方案。

患者浏览器薄壳使用相同的 Record Application Service，支持：

- 新增、读取和修改症状/TNSS；
- HttpOnly 开发会话；
- 页面刷新和服务重启恢复；
- 版本冲突提示和重新读取；
- 移动端记录信息层级与中央“＋”入口。

Browse 无需患者登录，仅读取同时满足已发布、患者可见、当前版本有效和
媒体可用门禁的文章/视频。列表、分类、搜索和详情共用服务端门禁；
已下架或不可见内容不能通过 ID 绕过。

`account` 会明确返回 `capability_unavailable`，不会用 Mock 结果伪装为业务成功。

## 本地运行

需要 Node.js 22.13 或更新版本。

```bash
cd "/Users/chenqiqiang/work/抗敏先锋AI鼻健康管理系统/src"
npm ci
npm run check
```

### 本地管理文章

`kangmin-admin` 与患者 CLI 使用不同的会话和环境变量。当前只允许在
local/integration 环境建立开发管理员会话：

```bash
KANGMIN_APP_ENV=local \
KANGMIN_ALLOW_DEV_ADMIN_SESSION=1 \
npm run dev:admin-session -- --subject owner-a

export KANGMIN_ADMIN_TOKEN="<opaque admin token>"
node dist/cli/kangmin-admin.js content article create \
  --title "换季鼻健康" \
  --category "鼻健康" \
  --summary "科普摘要" \
  --body "已审核科普正文" \
  --source "已审核来源" \
  --idempotency-key article-demo-1 \
  --json
```

文章创建后是草稿。发布/下架必须提供当前 revision 和 `--yes`；发布后
患者 Browse 立即可见，下架后列表、搜索和详情立即不可见。

开发管理员会话不是生产认证。生产模式即使设置开关也拒绝创建开发管理员会话。

建立仅限本地开发的测试会话：

```bash
KANGMIN_ALLOW_DEV_SESSION=1 npm run dev:session -- --subject patient-a
```

将返回的 `sessionToken` 放入环境变量，不要写入命令参数、仓库或日志：

```bash
export KANGMIN_SESSION_TOKEN="<opaque token>"
node dist/cli/kangmin.js record symptom add \
  --local-date 2026-07-31 \
  --nasal-congestion 2 \
  --nasal-itching 1 \
  --sneezing 3 \
  --runny-nose 2 \
  --idempotency-key demo-20260731 \
  --json
```

默认数据库为 `src/.local/kangmin-mvp.sqlite`。可使用
`KANGMIN_DB_PATH` 指向隔离的测试 SQLite 文件。

启动仅限本地的患者浏览器薄壳：

```bash
KANGMIN_APP_ENV=local \
KANGMIN_ALLOW_DEV_SESSION=1 \
npm run start:http
```

然后访问 `http://127.0.0.1:8787/`。患者页面先尝试使用已有 HttpOnly
会话；只有未登录且服务端明确允许 local/integration 开发会话时，才创建
本地测试会话。

默认 `KANGMIN_APP_ENV` 是 `production`。即使误设
`KANGMIN_ALLOW_DEV_SESSION=1`，生产模式也不会开放 `/dev/session`。

## 安全边界

- Record 命令不接受 `patient_id` 或 `user_id`，身份从不透明会话解析。
- TNSS 总分由四项 0–3 分在服务端计算。
- 创建要求幂等键；更新要求 `expectedRevision`。
- 每位患者每天只保留一条症状/TNSS 记录。
- 当前开发会话适配器不是生产身份认证。
- Agent 只通过 Record Application Service 的只读投影获取快照，不直接读写 Record repository。
- Agent 的 `unknown` 不当作安全；安全无法确认时终止后续流程。
- 未获批的临床内容不会进入 Agent 输出。
- 浏览器不能读取 HttpOnly 会话令牌，也不能提交权威患者 ID 或 TNSS 总分。
- 患者可浏览不代表 Agent 可检索；本 Browse 投影不接入 Agent 知识库。
- 当前未实现管理员内容导入、审核、发布或媒体上传；无已发布数据时返回真实空列表。
- Record 和 Session 应用服务只依赖端口；SQLite 是当前本地适配器，不是
  已完成的 D1 生产适配器。
- 当前没有获批的临床规则、证型、方案、知识库或模型调用。
- 新代码不得导入 `legacy/` 业务模块。
