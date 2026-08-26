---
type: ops
number: "012"
date: 2026-08-26
title: 管理后台二级文件管理部署
tags: [admin, media, references, sqlite, deploy]
related: ["ops/010", "ops/011"]
---

# ops/012 管理后台二级文件管理部署

## 执行概述

- 时间：2026-08-26
- 执行人：Codex（作者授权）
- 环境：腾讯云 Web 试用环境 `140.143.120.176`
- 代码基线：`main@880421f`
- 发布目录：`/srv/kangmin-cli/releases/file-management-880421f`
- 发布包 SHA-256：`79317d3afe77bf7135a9b6271c60b5de35bcf91041e80b4640ea1cdcadcba58f`

本次完成 Issue #279 的收尾：文章、视频和 AI 知识任务提供二级文件管理入口，按图片、视频、
知识文件与附件展示业务引用去向；草稿、下架内容或停用知识仍引用文件时也拒绝删除。

## 步骤一：合并与门禁

实现 PR #294 的 `quality`（3 分 19 秒，含 PostgreSQL 16 契约）与 `image`（43 秒）全绿后
squash 合并为 `880421f`，源提交与合并提交文件树一致，Issue #279 自动关闭。完整
`cd src && npm run check`、真实浏览器双视口 E2E、sequential-thinking 与 `km-review` 均通过，
P0–P2 清零。

## 步骤二：生产副本预演

候选 release 使用正式 SQLite 在线备份副本在 8788 启动，`/live`、后台与新静态资源为 200，
副本 `quick_check=ok`。在副本中建立下架视频与文件引用，通过真实管理会话和 HTTP 命令验证：
文件列表返回视频名称、`unpublished` 状态及文件用途；直接删除返回 `validation_failed`；显式
解除业务引用后删除成功，临时内容与文件均清零。

## 步骤三：备份与切换

切换前生成并验证正式备份：

`/srv/kangmin-cli/backups/kangmin-mvp-20260826-181645-before-file-management-880421f.sqlite`

备份 `quick_check=ok` 后，通过临时符号链接原子替换 `/srv/kangmin-cli/app`；启动健康失败会自动
回滚到 `knowledge-lifecycle-0f4527f`。本次启动健康通过，旧 release 与正式备份保留回滚。

## 步骤四：上线后验证与清理

- 应用与 Nginx active，`NRestarts=0`，清理后仅 8787 监听；
- 公网 HTTPS 首页、`/admin`、`/live` 为 200；`/ready=503` 仍只因既有加密密钥未配置；
- 正式库与备份 `quick_check=ok`，23 项迁移和八项计数保持
  `22/11/21/136/136/51/15/26`；
- 公网管理 JS/CSS、release 与本地合并构建 SHA-256 逐字节一致；部署后无 error 日志；
- 8788 transient service、候选库、候选媒体目录、本机与服务器传输包均已清理。

## 已知限制

- 当前试用环境仍使用 SQLite；PostgreSQL 等价性由 PR CI 的 PostgreSQL 16 契约证明。
- 本轮证明工程门禁与 Web 试用环境可用，不等于客户人工验收或医学批准。
