---
name: 双后端迁移同步纪律
description: SQLite 与 PG 迁移必须同步写，CI 会跑 PG 契约测试暴露缺失
metadata:
  type: feedback
---

SQLite（`database.ts` MIGRATIONS）与 PostgreSQL（`pg-migrations.ts` PG_MIGRATIONS）的表结构迁移必须**同步写**：CI 的 quality 门禁会跑 PG 契约测试（`KANGMIN_TEST_DATABASE_URL`），缺列/缺 CHECK 直接失败，本地无 PG 实例时这些测试被跳过，缺失不会被本地测试发现。

**Why:** 2026-08-09 智能体 v4 开发轮只写了 SQLite 0011/0012 迁移，本地 245 测试全绿，PR 合入门禁时 CI 暴露 `column "phase_code" does not exist`，被迫补 PG 0004 迁移 + 修两个 PG 契约用例（insertPlan 未传 audience → NULL 不匹配查询）。

**How to apply:** 改 SQLite 迁移时同步检查 `pg-migrations.ts` 是否有对应列/约束变更；PG 的 CHECK 修改用 DROP/ADD CONSTRAINT（同 0003 先例）；PG 契约测试的 fixture 数据必须带新查询的过滤列（NULL 不匹配 `= ?`）。相关：[[20260809-decision-prioritization]]
