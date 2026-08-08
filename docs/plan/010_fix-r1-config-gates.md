# 修复 Issue R1：配置开关域（组合根接线）

> 来源：[`../reviews/008_cli-dev-status-adversarial-review.md`](../reviews/008_cli-dev-status-adversarial-review.md) P0-5、P0-6
> 同类病：默认行为在错误环境下"太宽容"或"焊死"，都是 `composition-root.ts` 的接线缺口。
> 复杂度：低｜建议分支：`codex/issue-<n>-config-gates`

## 问题与证据

### 1. 环境测试桩在非开发环境返回成功假数据（P0-6）

- `src/app/composition-root.ts:73-79`：`defaultEnvironmentProvider()` 无条件返回 `TestEnvironmentProvider`，任何 `KANGMIN_APP_ENV` 下 `browse environment current/forecast` 都返回固定假数据且成功退出
- 假数据 payload 标了 `test-double`、doctor 也报 `not_configured`，但**正常患者命令返回成功**，违反"未实现能力明确报错"的交付原则
- `src/infrastructure/test-environment-provider.ts:23` 自述"不接真实外部供应商"

### 2. `planBrowseEnabled` 无注入口 + browse 首页无环境聚合（P0-5）

- `src/app/composition-root.ts:213`：裸构造 `new SqliteContentReadRepository(database)`，`planBrowseEnabled` 永远 false（`sqlite-content-read-repository.ts:152`），方案浏览被焊死、返回成功空列表
- `src/modules/browse/browse-service.ts:15-34`：home 只聚合文章/视频/分类，无环境区块（设计：环境信息进入 browse）

## 范围

1. `defaultEnvironmentProvider` 增加环境判断：`KANGMIN_APP_ENV ∈ {local, integration}`（或显式允许开关）时才返回测试桩；其余环境环境命令 fail-closed 抛 `provider_unavailable`
2. doctor 的 environment-data 检查与新语义对齐
3. 组合根增加方案浏览开关注入（如 `KANGMIN_PLAN_BROWSE_ENABLED=1`；默认仍 false，临床冻结前不放开）
4. `browse home` 聚合环境区块（当前环境摘要注入 BrowseHome 契约）

## 非范围

- 真实环境数据供应商接入（后续独立任务）
- 方案浏览的患者端 UI（壳任务）
- 规则包 candidate → approved 的临床冻结流程

## 验收标准

- `KANGMIN_APP_ENV=staging` 下 `kangmin browse environment current --json` 返回 `provider_unavailable`（exit 5），不返回假数据
- `KANGMIN_APP_ENV=local` 下环境命令行为不变
- 开关关闭时 `browse plan list` 维持现状（空）；`KANGMIN_PLAN_BROWSE_ENABLED=1` 且有 enabled 方案时返回真实列表
- 裸 `kangmin browse` 输出含环境区块（数据源不可用时该区块明确标注状态，不伪造）
- 新增测试锁定以上四条

## 风险

- 低：只动组合根与 browse 服务，不改数据表；注意 staging 语义变化会影响既有 e2e 环境假设（检查 web-browser-e2e 是否依赖环境命令成功）

## 验证方式

- `cd src && npm run check` 全绿（typecheck + 架构门禁 + build + 全部测试 + web e2e）
- 手动冒烟：staging/local 两种环境各跑一次 environment 与 plan 命令
