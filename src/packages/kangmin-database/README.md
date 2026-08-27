# kangmin-database

抗敏先锋的双后端数据适配包，只实现 `@kangmin/core` 定义的端口。

- `src/sqlite/`：本地与体验环境的 SQLite 实现及迁移
- `src/postgres/`：生产 PostgreSQL 实现及迁移
- `src/shared/`：两个后端共用的幂等结果与加密字段转换
- `tests/`：契约测试说明；现有双后端契约迁移期间仍由根测试区统一运行
