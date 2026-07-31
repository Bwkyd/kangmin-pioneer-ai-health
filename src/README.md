# 抗敏先锋 CLI-first 新实现

这里是与 `legacy/` 隔离的新应用核心。当前只实现 Issue #125 的 Patient
Record 最小纵向闭环，不能宣称完整产品或正式医疗闭环已经完成。

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

## 安全边界

- Record 命令不接受 `patient_id` 或 `user_id`，身份从不透明会话解析。
- TNSS 总分由四项 0–3 分在服务端计算。
- 创建要求幂等键；更新要求 `expectedRevision`。
- 每位患者每天只保留一条症状/TNSS 记录。
- 当前开发会话适配器不是生产身份认证。
- 当前没有临床规则、证型、方案、知识库或模型调用。
- 新代码不得导入 `legacy/` 业务模块。
