# 贡献与 Agent 开发流程

## 1. Issue 先行

任何功能、修复、重构或自动化变更都必须先有 Issue。Issue 至少包含目标结果、范围、非范围、验收标准、风险等级和验证计划。需求未确认前，不进入实现、PR 或部署。

## 2. 分支与 worktree

- 分支格式：`codex/issue-<编号>-<简短说明>`。
- 中高风险任务使用独立 worktree；低风险单文件改动可只使用独立分支。
- 创建 worktree：`scripts/worktree-create.sh <Issue编号> <slug>`。
- 不同 Agent 不得同时修改同一文件；公共类型、迁移、权限和核心接口由唯一集成候选串行修改。
- `.worktrees/` 永远不提交。

## 3. 实现与验证

- Node.js 使用 `.nvmrc` 指定的版本。
- 新 CLI 在仓库根目录运行 `npm run build && npm test && npm run lint`。
- 安装旧实现依赖：`cd legacy && npm ci`。
- 旧实现本地门禁：在 `legacy/` 内运行 `npm run check`（Lint、生产依赖安全审计、构建和测试）。
- UI 变更还要验证真实浏览器路径并附截图。
- 数据库、权限、临床规则、核心接口或部署变更按高风险处理，要求独立审核和明确发布授权。

## 4. PR 与合并

- PR 必须关联 Issue，描述用户可见结果、风险边界和验证证据。
- 禁止直接推送 `main`，禁止 force push 或删除 `main`。
- 首次克隆后在仓库根目录运行 `bash scripts/install-git-hooks.sh`，安装本地 `main` 推送保护钩子。
- CI `quality` 通过后才具备合并资格。
- 自动化门禁通过不等于授权合并、部署或客户验收；这些动作仍需明确授权。

当前私有仓库套餐不支持服务端分支保护。本地钩子只能防误操作，不能替代 GitHub 强制规则；详见 `docs/runbooks/github-governance.md`。

## 5. 收尾

合并后先确认 PR 状态和 `main` 的最终 Git tree，再关闭 Issue。清理前运行 `scripts/worktree-audit.sh <路径>`，确认没有未提交文件或独有成果；获得授权后才能删除 worktree 和分支。

## 6. 安全边界

- 不提交 `.env*`、令牌、密码、患者信息或客户私密资料。
- `docs/客户资料/` 仅保留在受控本地环境。
- 医疗辨证必须由固定规则树先得出结果，模型只负责解释和检索已审核知识。
