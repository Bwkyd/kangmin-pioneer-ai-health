# Issue #114：归档旧实现并建立 CLI-first src 边界

## 目标

把现有 Vinext/Cloudflare 产品集中到 `legacy/`，在根目录建立新的 `src/` 实现入口。

## 范围

- 移动旧源码、配置、依赖锁、迁移、资源和测试。
- 保持旧实现可以从 `legacy/` 构建、测试和 lint。
- 更新 CI、依赖更新配置和仓库说明中的工作目录。

## 非范围

- 不实现四组 CLI 命令。
- 不修改临床规则、RAG 内容、数据库模型或部署。
- 不移动客户资料、仓库记忆或托管项目标识。

## 验收标准

- [x] 旧产品代码集中在 `legacy/`。
- [x] 根目录存在职责明确的 `src/`。
- [x] `cd legacy && npm run build` 通过。
- [x] `cd legacy && npm test` 通过。
- [x] `cd legacy && npm run lint` 通过。
- [x] `git diff --check` 通过。

## 风险

- 等级：中。
- 数据库/权限/临床规则/核心接口/部署影响：不改业务行为；路径错误可能破坏旧构建、CI 或迁移发现。

## 文件所有权

| Agent | 文件或目录 | 是否可写 |
| --- | --- | --- |
| 主 Agent | 本 Issue 的目录移动、根级说明、CI 路径和本计划 | 是 |

## 进度

| 步骤 | 状态 | 证据 |
| --- | --- | --- |
| 需求确认 | completed | GitHub Issue #114 |
| 实现 | completed | 旧实现已整体迁入 `legacy/`，新建 `src/README.md` |
| 本地门禁 | completed | build PASS；授权环境完整测试 127/127 PASS；lint 0 errors、4 warnings；生产依赖 0 vulnerabilities；`git diff --check` PASS |
| 审核 | completed | Git rename 检测确认除 3 个路径适配文件外，旧实现均为 100% 内容一致移动；Sites 元数据打包结果与根配置一致；PR #115 `quality` PASS |
| 合并/发布授权 | blocked | 等待明确授权 |

## 候选版本

- 分支：`codex/issue-114-archive-legacy-src`
- 业务实现 SHA：`4f4c327dd213832e3991a1fc24ceab94612a3b68`
- PR HEAD：分支 HEAD（以 `git rev-parse HEAD` 和 GitHub 回读为准）
- PR：[#115](https://github.com/Bwkyd/kangmin-pioneer-ai-health/pull/115)（Draft）

## 阻塞项

- 合并和发布未授权。
