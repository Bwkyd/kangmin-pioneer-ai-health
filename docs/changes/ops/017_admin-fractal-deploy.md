---
type: ops
number: "017"
date: 2026-08-28
title: 管理后台最小分形拆分部署
tags: [admin, fractal, deploy, rollback]
related: ["ops/016"]
---

# ops/017 管理后台最小分形拆分部署

## 执行概述

- 时间：2026-08-28
- 执行人：Codex（作者授权）
- 实现：Issue #364–#369、PR #370–#375，最终合并为 `main@f5dc36a`
- Web release：`/srv/kangmin-cli/releases/admin-fractal-f5dc36a`
- 发布包 SHA-256：`698702ca3d97cbee324ee6d30511f93e16746ca216ec1fbe6f088efe87eb83fd`
- 正式备份：`/srv/kangmin-cli/data/backups/kangmin-mvp-20260828-001019-before-admin-fractal-f5dc36a.sqlite`
- 备份 SHA-256：`1ac4e0f9c9fe2b8d258ae86f20cd3d691816508a7e78d5cee40802886f1bac9c`

本次只部署管理后台最小分形拆分：将辅助功能、内容叶子视图、文章/视频内容管理和 AI 知识管理从 `AdminApp` 提取为同构功能单元。API、数据库迁移、权限、患者功能、truth 和医学规则未修改。

## 构建与候选预演

从 `origin/main@f5dc36a` 归档到隔离目录，干净安装、构建和生产依赖审计通过，0 个已知漏洞。发布包排除 `node_modules`、AppleDouble 和全部 `.env*`，上传后逐字节复核 SHA-256；Linux 服务器再执行 `npm ci --omit=dev`。

候选 release 使用正式 SQLite 在线备份副本和媒体副本在 8788 启动，`/`、`/admin`、`/live` 为 200，`/ready` 为既有 503；候选库 `quick_check=ok`、24 项迁移。通过 SSH 隧道运行真实 Chromium，以候选库短期开发管理员会话登录后台，实际进入工作台、文章、视频、消息和 AI 知识入口，控制台错误与失败请求均为 0。正式 8787 在候选期间持续为 200。

## 正式备份、切换与回滚

切换前记录正式库关键表计数并用 SQLite backup API 生成权限 0600 的一致性备份；备份 `quick_check=ok`。独立软链先演练“旧 release → 新 release → 旧 release”，确认原子替换与回滚路径。

随后原子切换 `/srv/kangmin-cli/app` 并重启 `kangmin-cli.service`。切换脚本在服务或 `/live` 失败时自动恢复 `/srv/kangmin-cli/releases/workspace-fractal-ec60f59-r2`；本次未触发回滚。

## 上线后验证与限制

- 应用与 Nginx active，`NRestarts=0`，只监听 `127.0.0.1:8787`；
- 正式库与备份 `quick_check=ok`，迁移仍为 24 项，最新 `0022_content_category_registry`；
- 患者/启用方案/启用知识/知识分块/向量/会话/评估/已发布视频/分类节点/关联/成功迁移报告为 `28/11/21/136/136/47/17/26/20/38/26`，切换前后不变；
- 本机和公网 `/`、`/admin`、`/live` 均为 200；release 与 HTTP 返回的管理 JS SHA-256 一致；
- 公网 Chromium 实际加载首页和后台登录页，控制台错误与失败请求均为 0；发布后 systemd 无 warning；
- `/ready=503` 仍只因试用环境既有加密密钥未配置，不是本轮回归。

预检时发现三项不影响正式流量的操作差异：非交互 SSH 需显式加入固定 Node PATH；CLI `bin` 路径相对包目录而非 workspace 根；zsh 中 `path` 是特殊变量，不能用作普通循环名。均在切换前或只读核验阶段修正。旧 release 与正式备份保留回滚；候选数据、媒体副本、日志、隧道和传输包在验证后清理。

该部署只证明试用服务器上的工程版本真实运行，不等于客户验收、临床批准或正式生产就绪。
