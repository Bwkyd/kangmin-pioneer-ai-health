# runtime、CLI 与 API 入口收口有界实验

- 日期：2026-08-27
- 状态：本地验证通过；真实 PostgreSQL/S3/OCI 待 CI
- 基线：`origin/main@8ba6e18`
- 对应 Issue：#349

## 假设与边界

建立唯一 `@kangmin/runtime` 组合根，并让 `@kangmin/cli`、`@kangmin/api` 只通过 runtime 取得数据库与外部适配器，可以机械阻止入口自行装配。本轮只移动入口与评测工具、改写导入和构建路径，不改命令参数、stdin/stdout、退出码、Cookie、JSON、NDJSON、提示词、SQL、truth、医学规则或生产数据。

执行前放行标准：先写 `check-runtime-entrypoints.mjs` 并确认旧结构失败；runtime 明确拥有 core/database/integrations；CLI/API 不依赖 database/integrations；旧 `app/cli/dev/evals/http` 零残留；真实进程与传输窄测、四组冒烟、完整门禁和浏览器 E2E 通过。

## 结果

- 三个组合根迁入 `packages/kangmin-runtime`；CLI、开发入口迁入 `apps/kangmin-cli`；HTTP 服务迁入 `apps/kangmin-api`；评测执行逻辑进入 runtime，冻结任务集进入 tests fixture。
- `kangmin` 与 `kangmin-admin` 两个命令名、版本和路径由 CLI manifest 明确声明；根入口仍保留相同 bin 名。
- 入口门禁验证 CLI/API 只依赖 core/runtime，禁止直接导入 database/integrations；五个旧顶层目录已清空，迁移白名单为空。
- 首轮真实 HTTP 窄测发现 API 搬家后仍按旧编译位置寻找 `dist/web`，首页返回 503；修复为新 workspace 到根后台产物的明确路径后，HTTP 10/10 与真实浏览器复测通过。后台检查器硬编码旧 HTTP 源路径、CLI 版本 manifest 相对路径也同步修复。
- 四组冒烟 2/2、2/2、3/3、6/6；完整本地门禁 358 通过、78 条外部资源测试跳过、0 失败，后台 2 条与真实 Chromium E2E 通过。

## 成本与限制

根构建增加 runtime/CLI/API 三个独立 typecheck/build；Docker builder 和 runner 必须携带对应 manifest/dist。演化复诊显示代码文件 306、p50 121、超 600 行占比 14.4%、用例密度 6.3 不变；`src` 顶层 9→4，已低于通用上限并删除专用宽度豁免，导航成本因三个 workspace 小壳从 14.18 暂升到 14.23。真实 PostgreSQL、S3 和 OCI 由 PR CI 放行，交付链在 #350 统一复诊。
