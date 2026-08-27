---
type: ops
number: "016"
date: 2026-08-27
title: 最小分形 workspace 部署
tags: [workspace, architecture, deploy, rollback]
related: ["arch/006"]
---

# ops/016 最小分形 workspace 部署

## 执行概述

- 时间：2026-08-27
- 执行人：Codex（作者授权）
- 实现：Issue #344–#350、PR #351–#357，最终实现合并为 `main@ec60f59`
- Web release：`/srv/kangmin-cli/releases/workspace-fractal-ec60f59-r2`
- 发布包 SHA-256：`3dd1108eb5a2e949fe8465296fad559f650d470b6c239ef5a47b655baf2815a2`
- 正式备份：`/srv/kangmin-cli/data/backups/kangmin-mvp-20260827-175805-before-workspace-fractal-ec60f59.sqlite`
- 备份 SHA-256：`1ac4e0f9c9fe2b8d258ae86f20cd3d691816508a7e78d5cee40802886f1bac9c`

本次只改变 `src` 的代码组织和运行入口：顶层收敛为 `apps/packages/scripts/tests`，管理后台、API、CLI、小程序和四个能力包采用同一 workspace 小壳；旧患者 Web 退役，患者端继续使用微信小程序。SQL、迁移、truth、医学规则和患者数据未修改。

## 合并与门禁

PR #357 的 `quality` 3 分 21 秒通过 PostgreSQL 16、MinIO/S3、完整回归与真实 Chromium E2E；`image` 59 秒通过 OCI 构建、容器新 CLI 入口、生产依赖审计和 SBOM。最终本地四组冒烟为 2/2、2/2、3/3、6/6；`src` 358 项通过、78 项外部资源测试本地跳过、后台 2 项与浏览器通过，`legacy` 127/127。sequential-thinking 七步实施反思、五步部署增量反思和 `$km-review` 最终 P0–P2 为 0。

## 候选预演与平台差异

首个候选把 macOS 安装的生产 `node_modules` 一并上传到 Linux。新 API 在导入 PDF 能力时因 `@napi-rs/canvas` 原生绑定平台不匹配退出，8788 不可达；正式 8787 始终为 200，没有切换。只打开安装脚本不能解决跨平台二进制问题，因此没有复用失败候选。

第二个候选只传 lockfile、manifests 和编译产物，在服务器 Linux 上执行 `npm ci --omit=dev`，生产依赖审计为 0 漏洞且 Linux canvas 绑定存在。候选使用生产 SQLite 在线备份副本，在 8788 真实启动新 `apps/kangmin-api/dist/server.js`：`/`、`/admin`、`/live` 为 200，`/ready` 为既有加密配置 503；副本 `quick_check=ok`、24 项迁移，患者/对话/评估为 28/47/17，与正式库一致。

## 正式备份、切换与回滚

切换前用 SQLite backup API 生成正式备份，`quick_check=ok` 且患者/对话/评估为 28/47/17。独立符号链接探针先实际执行“旧 → 新 → 模拟失败 → 旧”，确认原子替换和恢复逻辑。

正式发布原子切换 `/srv/kangmin-cli/app`，并新增 systemd drop-in，把旧 `dist/http/server.js` 覆盖为 `apps/kangmin-api/dist/server.js`。部署脚本在 daemon reload、restart 或 20 秒 `/live` 失败时会恢复旧 release、删除新 drop-in、重载并重启；本次新服务在第二次轮询通过，未触发回滚。

## 上线后验证与限制

- `kangmin-cli` 与 Nginx active，`NRestarts=0`，实际 ExecStart 为新 API workspace；
- 正式库 `quick_check=ok`，24 项迁移、最新 `0022_content_category_registry`；关键计数为 `28/11/21/136/136/47/17/26/20/38/26`，切换前后不变；
- 本机和公网 `/`、`/admin`、`/live` 均为 200；`/ready=503` 仍只因既有加密配置；
- 生产 Chromium 加载 `/` 与 `/admin`，两者显示同一管理后台，标题、正文、网络、控制台与 page error 检查通过；systemd 本次发布后无 warning 日志；
- 旧 release `category-registry-bf44d26` 与正式数据库备份保留回滚。失败候选、候选库、传输包和临时配置在记录完成后清理。

该部署证明当前试用环境的新入口真实运行，不等于微信真机验收、客户验收、临床批准或 `/ready` 已达到生产就绪。
