# Issue #19：冻结客户端、身份、部署资源与模型供应商

## 目标

基于当前代码和资源真实状态，冻结一期技术路线，避免把 H5、空资源绑定或未实现检索表述为已完成能力。

## 范围

- H5/原生小程序形态。
- 用户身份与监护关系。
- D1/R2 生产资源和环境隔离。
- 模型网关和知识检索供应商。

## 非范围

- 不创建付费生产资源。
- 不接入微信 AppID、短信或真实用户身份。
- 不合并、部署或关闭 Issue。
- 不实现依赖这些决定的功能 Issue。

## 验收标准

- [x] 本轮只处理 Issue 明确列出的 4 个实体。
- [x] D-007～D-010 均记录负责人、结论和日期。
- [x] local/integration/staging/production 隔离原则明确。
- [x] 数据区域、凭据和费用责任保留为生产门禁。
- [x] 项目方书面冻结 D-007～D-010。

## 风险

- 等级：高
- 数据库/权限/临床规则/核心接口/部署影响：本轮只形成架构候选；错误冻结会造成客户端、身份、数据和部署返工。

## 文件所有权

| Agent | 文件或目录 | 是否可写 |
| --- | --- | --- |
| 主 Agent | `docs/decisions/issue-19-platform-candidate.md` | 是 |
| 主 Agent | `docs/plans/active/issue-19-platform-architecture-decisions.md` | 是 |

## 进度

| 步骤 | 状态 | 证据 |
| --- | --- | --- |
| 真实基线 | completed | 当前为 vinext H5；Sites 已有项目 ID；D1/R2 为空；DeepSeek 已接线；检索未实现 |
| 技术决策 | completed | 项目方于 2026-07-23 批准 H5、手机号、D1/R2、DeepSeek V4 Pro/Vectorize |
| 本地门禁 | completed | `git diff --check`、lint、生产依赖审计、构建及 28/28 自动化测试通过 |
| 审核 | pending | 待 Draft PR 审核 |
| Draft PR | in_progress | 已获推送和创建 Draft PR 授权 |
| 合并/部署授权 | blocked | 尚未获得合并或部署授权 |

## 候选版本

- 分支：`codex/issue-19-platform-architecture-decisions`
- 提交 SHA：见 Draft PR head
- PR：未创建

## 阻塞项

- D1/R2/Vectorize integration、staging 和 production 资源尚未创建。
- 短信服务账号、生产主体账号及生产凭据尚未提供。
- 这些资源阻塞后续真实集成和生产部署，不再阻塞一期架构开发。
