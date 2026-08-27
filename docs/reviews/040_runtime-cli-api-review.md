# runtime、CLI 与 API 入口交付评审

- 基线：`codex/src-fractal-06`，源自 `origin/main@8ba6e18`
- 对象：runtime/CLI/API workspaces、真实进程与传输路径、构建和 Docker
- 方法：sequential-thinking 六步元反思；`km-review` 患者可懂性、工程事实、医学安全三视角

## 患者可懂性视角

- P0–P2：未发现。
- 患者 CLI、小程序 HTTP/NDJSON、管理后台 Cookie 和页面路径保持既有契约；真实进程、HTTP 和浏览器证据均已执行。

## 工程事实视角

- P0–P2：未发现。
- runtime 是唯一可以同时依赖 core、database、integrations 的 workspace；CLI/API 门禁拒绝绕过 runtime。
- 有界实验与首轮 CI 实际发现并修复四种位置变式：API 静态资源根、CLI 版本 manifest、后台检查器的 HTTP 源路径、镜像 CI 的旧 CLI 冒烟路径。结构检查现同时扫描 CI、Docker 和根 package，防止旧编译入口复活。
- 根构建顺序与 Docker builder/runner 已覆盖三份新 workspace；CLI 两个版本入口、完整测试和真实浏览器通过。
- 首轮质量 CI 已验证 PostgreSQL/S3 并通过；镜像因 CI 旧路径失败后已修复，仍须第二次 OCI/容器冒烟绿灯放行。

## 医学安全视角

- P0–P2：未发现。
- 问卷、证型、分期、方案、提示词、模型输出校验、知识发布门禁和患者文案均未修改；完整回归继续覆盖 unknown、急症、药量和规则包失败关闭路径。

## 结论

当前 P0、P1、P2 为 0，可以进入 PR/CI。实现达成单一组合根和薄入口约束；必须等 CI 的 PostgreSQL/S3/OCI 全绿后合并，部署留给 #350 的统一预演和原子发布。
