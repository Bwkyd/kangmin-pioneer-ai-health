# 数据库包双后端同构有界实验

- 日期：2026-08-27
- 状态：本地验证通过；PostgreSQL/OCI 待 CI
- 基线：`origin/main@cfec737`
- 对应 Issue：#347

## 假设与边界

把 SQLite、PostgreSQL、迁移和双方共用的字段转换收进 `@kangmin/database`，并让两个后端使用相同短文件名，可以减少“同一种仓储去哪里找”的歧义。本轮只移动实现和改写导入，不改 SQL、schema、迁移顺序、事务、端口、truth、医学规则或生产数据，也不顺手拆长仓储。

执行前放行标准：数据库包独立 typecheck；只依赖 core、Node 和 pg；旧 infrastructure 不残留数据库实现；SQLite 24 个既有迁移条目与 PG 迁移内容不变；双后端契约、失败路径、四组冒烟、完整门禁和真实浏览器 E2E 通过。

## 结果

- 包内形成 `sqlite / postgres / shared`：两种后端都有 `database.ts`、`account-repository.ts`、`record-repository.ts` 等同名位置，类名仍明确保留 Sqlite/Pg。
- `shared` 只承载双方共用的加密字段转换和幂等结果；外层组合根与测试统一经 `@kangmin/database/*` 访问。
- 数据库包独立 typecheck、构建和依赖门禁通过；旧 infrastructure 只剩对象存储、模型、环境、身份、远程调用与日志适配器。
- SQLite/迁移窄测 18 条通过；13 条 PostgreSQL 测试因本机未配置 URL 如实跳过。四组冒烟 2/2、2/2、3/3、6/6；完整本地门禁 360 通过、78 条外部资源测试跳过、0 失败，真实 Chromium E2E 通过。

## 成本与限制

本轮代码文件、p50、超 600 行占比和用例密度仍为 306、121、14.4%、6.3；导航成本从 13.89 暂升到 14.06。新增包边界已经生效，但旧 app/cli/http/infrastructure 尚未收口，因此这是计划内中间态，不是“复杂度已经下降”的证据。

真实 PostgreSQL 16、MinIO/S3、OCI 包装由 PR CI 强制执行。本轮不触碰线上库，也不把迁移测试通过扩大为生产数据迁移授权。
