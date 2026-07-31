# 抗敏先锋 CLI-first 新实现

这里是与 `legacy/` 隔离的新应用核心。Issue #125 建立了 Patient Record
命令纵切，Issue #127 将症状/TNSS 接入真实患者浏览器薄壳。当前仍不能
宣称完整产品、生产身份、D1 数据层或正式医疗闭环已经完成。

## 当前能力

患者公开命令固定为四组：

```text
agent / record / browse / account
```

本 MVP 真实实现：

```text
record symptom add
record symptom list
record symptom show
record symptom update
```

患者浏览器薄壳使用相同的 Record Application Service，支持：

- 新增、读取和修改症状/TNSS；
- HttpOnly 开发会话；
- 页面刷新和服务重启恢复；
- 版本冲突提示和重新读取；
- 移动端记录信息层级与中央“＋”入口。

`agent`、`browse` 和 `account` 会明确返回 `capability_unavailable`，不会用
Mock 结果伪装为业务成功。

## 本地运行

需要 Node.js 22.13 或更新版本。

```bash
cd "/Users/chenqiqiang/work/抗敏先锋AI鼻健康管理系统/src"
npm ci
npm run check
```

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
- 浏览器不能读取 HttpOnly 会话令牌，也不能提交权威患者 ID 或 TNSS 总分。
- Record 和 Session 应用服务只依赖端口；SQLite 是当前本地适配器，不是
  已完成的 D1 生产适配器。
- 当前没有临床规则、证型、方案、知识库或模型调用。
- 新代码不得导入 `legacy/` 业务模块。
