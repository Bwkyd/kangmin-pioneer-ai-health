# Issue #14：修复候选提交竞态

## 目标

确保 AI 候选答案在提取或固定规则提交期间不能造成“当前答案”与“已返回结果”不一致；任何实际发生的候选变更都必须作废在途请求。

## 范围

- 提取中和提交中禁用“采用候选/忽略”操作。
- 候选变更时使在途提取、评估或解释请求失效。
- 增加覆盖高危候选提交竞态的自动化回归。
- 重新运行完整本地门禁和独立双审。

## 非范围

- 不修改 D-001～D-011 临床或客户决策。
- 不修改固定规则、高危阈值、方案、视频、RAG、数据库或身份。
- 不部署，不关闭 Issue，不清理已有 worktree 或分支。

## 验收标准

- [x] 提取中和提交中候选操作不可用。
- [x] 候选变更不会允许旧评估结果落地。
- [x] 高危候选竞态有自动化覆盖。
- [x] `npm run check` 在本任务 worktree 通过。
- [ ] 真实浏览器旅程完成，或按实时浏览器可用性明确记录 BLOCKED。
- [x] Kimi K3 与 DeepSeek V4 Pro 独立复审均无 P0/P1。

## 风险

- 等级：高（Issue 标记 P0/risk-high）
- 数据库/权限/临床规则/核心接口/部署影响：不改数据库、权限和临床规则；影响问诊结果提交的一致性门禁；禁止部署直至修复验证完成。

## 文件所有权

| Agent | 文件或目录 | 是否可写 |
| --- | --- | --- |
| 主 Agent | `app/page.tsx` | 是 |
| 主 Agent | `lib/agent/` 中与候选交互状态直接相关的文件 | 是 |
| 主 Agent | `tests/` 中 Issue #14 回归测试 | 是 |
| 主 Agent | 本计划文件 | 是 |

## 真实基线

- 核验日期：2026-07-23（Asia/Shanghai）
- `origin/main`：`e6479354a57b726cf3ed1e09d32d0341df446b58`
- PR #15：已合并；Issue #14 因候选提交竞态重新打开并带 `agent-ready`
- 当前代码事实：提交时自由描述、提取按钮和主提交按钮已禁用，候选操作按钮未禁用且处理函数不会使在途请求失效
- `.openai/hosting.json`：已有 Sites `project_id`，D1/R2 均为 `null`
- 当前浏览器发现结果：无可用 Browser/Chrome 实例
- 既有任务 worktree：`.worktrees/issue-14-dynamic-followup`，含未提交状态文件，保持不动

## 进度

| 步骤 | 状态 | 证据 |
| --- | --- | --- |
| 需求确认 | completed | Issue #14 正文及 2026-07-23 重新打开评论 |
| 实现 | completed | 候选操作锁 + 候选变更作废在途请求 |
| 本地门禁 | completed | `git diff --check`、聚焦测试、`npm run check`；32/32 通过，生产依赖审计 0 漏洞 |
| 审核 | completed | 第 2 轮 Kimi K3 与 DeepSeek V4 Pro 均 P0=0、P1=0、PASS |
| 合并/发布授权 | blocked | 未获推送、合并或部署授权 |

## 候选版本

- 分支：`codex/issue-14-candidate-submit-race`
- 产品代码候选 SHA：`d35730db9fdbb7711bce33198b4004e1f35de9ac`
- PR：未创建

## 阻塞项

- 真实点击式浏览器 E2E：实现后再次实时核验仍无可用 Browser/Chrome 实例，保持 BLOCKED。
- 推送、PR、合并、部署、Issue 关闭及 worktree 清理：均未获授权。

## 审核记录

- 第 1 轮冻结 SHA：`130297b`
- Kimi K3：P0=0、P1=1、P2=3，`REVIEW_RESULT: FAIL`
- DeepSeek V4 Pro：P0=0、P1=1、P2=3，`REVIEW_RESULT: FAIL`
- 共同 P1：竞态测试只匹配源码形状，未行为级证明候选变化会使旧请求结果过期。
- 修复：新增生产使用的 `RequestVersion` 协调器；异步单测直接模拟“旧评估在途 → 候选变化 → 旧结果不得落地”，并保留 UI 禁用与接线断言。
- 第 2 轮冻结 SHA：`d35730db9fdbb7711bce33198b4004e1f35de9ac`
- Kimi K3：P0=0、P1=0、P2=2，`REVIEW_RESULT: PASS`
- DeepSeek V4 Pro：P0=0、P1=0、P2=3，`REVIEW_RESULT: PASS`
