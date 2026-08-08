# 修复 Issue R3：Agent 会话域（生命周期 + 身份契约）

> ✅ 已落地：Issue #155 → PR #158，squash 合入 main `efff3c5`（2026-08-04）。下文为开工前方案，行号证据基于旧基线，仅作档案留存。

> 来源：[`../reviews/008_cli-dev-status-adversarial-review.md`](../reviews/008_cli-dev-status-adversarial-review.md) P0-1、P0-4、P1-8
> 同类病：会话的身份、保留、恢复、同意这条契约链各环节都有缺口。
> 复杂度：高｜建议分支：`codex/issue-<n>-agent-session`（建议用 `scripts/worktree-create.sh`）

## 问题与证据

### 1. 匿名会话保留期零执行点（P0-1）

- `src/modules/agent/conversation-service.ts:60` 定义 24h 保留、:581-583 创建时写 `retention_until`
- 全仓 grep：**无任何查询过滤或清理任务引用 `retention_until`**
- `src/infrastructure/sqlite-conversation-repository.ts:100-107`：`findAnonymousSession` 只查 `patient_id IS NULL`，无时间条件
- `src/tests/agent-conversation.test.ts:99`：现有测试明确"凭 ID 恢复匿名会话成功"——与设计"匿名一次性体验不保存"（患者设计 §17-13）冲突

### 2. 双状态机分裂 + `continue` 违反设计契约（P0-4）

- `src/app/application.ts:276-356`：无 message → 旧 `AgentService`（`agent-service.ts:42-155` 只问一个急症问题后固定终局）；有 message → `ConversationService`
- `src/cli/kangmin.ts` 的 `agent continue` 强制 session ID；患者设计:216 契约为 `kangmin agent continue`（裸命令续最近会话）

### 3. 同意机制未成处理前置（P1-8）

- `src/modules/account/account-service.ts:29-36`：仅 `privacy`/`medical_boundary` 两类；患者设计:690-698 要求 5 类（缺健康数据使用授权、Agent 会话保存授权、定位用途说明）
- `src/app/application.ts:276` 起：agent/record 路由无任何 consent 校验
- `conversation-service.ts:126-146`：`saveConsent: true` 只是请求参数，不绑定/写入账户同意记录

## 范围

1. 匿名保留期执行：匿名会话查询加 `retention_until > now` 过滤（过期视为不存在）；启动时或定期清理过期匿名会话及其消息/决策/反馈
2. `agent continue` 支持裸命令：不带 ID 时解析该患者（或匿名调用上下文）最近一个 `awaiting_answer` 会话；CLI 帮助对齐设计契约
3. consent 扩到 5 类；`record` 写入前校验健康数据授权、`agent` 绑定保存前校验会话保存授权；`saveConsent: true` 时写入账户 consent 记录并以其 id 关联会话
4. 撤回同意后的影响：撤回健康数据授权 → record 写入拒绝（提示先授权）；撤回会话保存授权 → 不再允许绑定

## 非范围

- 旧 `AgentService` 与 `ConversationService` 的合并重写（见决策点；本批只做契约对齐，不做架构合并）
- 候选事实确认/修改/忽略入口、RAG 知识端口（智能化链路后续任务）
- 定位授权的实际定位功能（只建 consent 类型与文案）

## 验收标准

- 过期匿名会话凭 ID 恢复 → `resource_not_found`；清理任务执行后表中无过期匿名行；保留期内匿名续聊不受影响
- `kangmin agent continue`（不带 ID）续接最近待答会话；无待答会话时明确报错
- 未授权健康数据时 `record symptom add` 被拒并提示先 `account consent update`；授权后放行；撤回后再被拒
- `agent start --message ... --save-consent` 时写入账户 consent 记录，会话 `save_consent_id` 指向该记录
- 新增/调整测试覆盖以上全部（含替换 agent-conversation.test.ts:99 的旧语义）

## 风险

- 高：动会话生命周期与身份契约，牵连 CLI/HTTP/匿名语义三处调用面；`agent-conversation.test.ts` 多个用例语义要翻修
- 决策点（开工前定）：旧 `AgentService` 保留为纯急症分诊外壳（推荐，改动小）还是并入 `ConversationService`（彻底但大改）
- 注意与 R1/R2 无文件重叠，可独立开 PR

## 验证方式

- `cd src && npm run check` 全绿
- 手动冒烟：匿名 exec → 凭 ID resume（窗口内成功）→ 改库把时间推到 24h 后 → resume 失败 → 清理后无残留
