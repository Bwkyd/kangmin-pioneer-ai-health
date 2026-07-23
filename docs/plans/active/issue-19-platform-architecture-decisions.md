# Issue #19：冻结客户端、身份、部署资源与模型供应商

## 目标

基于当前代码和资源真实状态，形成一期技术路线候选，避免把 H5、空资源绑定或未实现检索表述为已完成能力。

## 范围

- H5/原生小程序形态。
- 用户身份与监护关系。
- D1/R2 生产资源和环境隔离。
- 模型网关和知识检索供应商。

## 非范围

- 不创建付费生产资源。
- 不接入微信 AppID、短信或真实用户身份。
- 不部署、推送、合并或关闭 Issue。
- 不实现依赖这些决定的功能 Issue。

## 验收标准

- [x] 本轮只处理 Issue 明确列出的 4 个实体。
- [x] 每项候选均说明当前事实、建议和待确认选择。
- [x] local/integration/staging/production 隔离原则明确。
- [x] 数据区域、凭据和费用责任保留为生产门禁。
- [ ] 项目方书面冻结 D-007～D-010。

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
| 候选方案 | completed | 4 项均形成最小选择和默认降级边界 |
| 本地门禁 | pending | 待执行文本和状态核验 |
| 审核 | blocked | 等待项目方确认 D-007～D-010 |
| 合并/发布授权 | blocked | 等待明确授权 |

## 候选版本

- 分支：`codex/issue-19-platform-architecture-decisions`
- 提交 SHA：待提交
- PR：未创建

## 阻塞项

- 客户尚未提供微信主体、AppID、业务域名和发布账号。
- D1/R2 生产资源未创建，费用与数据责任未确认。
- H5 登录供应商和向量检索供应商未确认。
