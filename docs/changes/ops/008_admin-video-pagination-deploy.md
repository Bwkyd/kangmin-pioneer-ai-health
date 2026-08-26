---
type: ops
number: "008"
date: 2026-08-26
title: 管理后台视频列表分页部署
tags: [admin, video, pagination, ui, sqlite, deploy]
related: ["ops/007"]
---

# ops/008 管理后台视频列表分页部署

## 执行概述

- 时间：2026-08-26
- 执行人：Codex（作者授权）
- 环境：腾讯云 Web 试用环境 `140.143.120.176`
- 代码基线：`main@ffc8628`
- 发布目录：`/srv/kangmin-cli/releases/admin-video-pagination-ffc8628`
- 发布包 SHA-256：`76d8b67543cdc5a07bb9d5ee36d4c2d4279e7b73e92afe98cc19b40e16624710`

本次为管理后台视频列表增加每页 20 条分页，并补充分类筛选。筛选变化回到第一页，预览、
编辑和上下架刷新保留有效页码；文章列表、患者端排序、内容数据和医学规则均未改变。

## 步骤一：合并与门禁

PR #286 的 `quality`、`image` CI 通过后 squash 合并为 `ffc8628`，源分支与合并提交文件树
一致。Node 22.23.1 下完整 `src` 门禁通过，包含类型、架构、小程序检查、构建、单元与契约
测试和真实浏览器 E2E；清单、结构、差异格式和密钥扫描通过。

sequential-thinking 六步元反思和 `km-review` 三视角发现并修复文章筛选行为被误改、测试锁死
排序后的行位置、分类值修剪后无法精确匹配三项 P2。最终覆盖 0/1/20/21/40/41 条边界、
首尾页、第二页预览与上下架、组合筛选和 390×844 窄屏几何，P0–P2 清零。详细结论见
`docs/reviews/025_admin-video-pagination-review.md`。

## 步骤二：生产副本预演

候选 release 在独立 8788 端口使用正式 SQLite 在线备份副本预演。`/live`、后台页面、真实
管理命令和新 JS/CSS 资源通过；管理接口返回 26 条正式视频。副本 `quick_check=ok`，23 项
迁移和八项数据计数为 `22/11/21/136/136/51/15/26`（患者/启用方案/启用知识/分块/向量/会话/
评估/已发布视频；迁移数单列），与切换前一致。预演结束后关闭 8788 并删除副本和日志。

## 步骤三：备份与切换

停止 `kangmin-cli.service` 后生成备份：

`/srv/kangmin-cli/backups/kangmin-mvp-20260826-163304-before-admin-video-pagination-ffc8628.sqlite`

备份 `quick_check=ok` 后，将 `/srv/kangmin-cli/app` 原子切换到候选 release 并启动服务；切换
脚本配置失败自动恢复旧链接。旧发布目录 `/srv/kangmin-cli/releases/admin-video-preview-b0b18a3`
与本次数据库备份继续作为回滚材料保留。

## 步骤四：上线后实效验证

- `kangmin-cli` 与 Nginx 均为 `active`，应用 `NRestarts=0`，只监听内部 `127.0.0.1:8787`，
  8788 已关闭；
- 公网首页、`/admin`、`/live` 均返回 200；`/ready=503` 仍只因试用环境未配置加密密钥；
- 正式库和备份均为 `quick_check=ok`，迁移与数据计数和切换前一致；
- 管理 JS/CSS 的 SHA-256 与本地合并构建逐字节一致，服务日志无新增业务错误；
- 传输包、本地打包目录、预演数据库和日志均已清理，正式备份与旧 release 保留回滚。

## 已知限制

- 本轮证明后台分页在自动化与生产候选数据上可用，不等于客户运营账号下的人工验收。
- 正式配置加密密钥后仍需单独验证并恢复 `/ready` 200。
