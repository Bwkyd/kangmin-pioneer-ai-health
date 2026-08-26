---
type: ops
number: "013"
date: 2026-08-26
title: 管理后台工作台精简部署
tags: [admin, workbench, responsive, deploy]
related: ["ops/012"]
---

# ops/013 管理后台工作台精简部署

## 执行概述

- 时间：2026-08-26
- 执行人：Codex（作者授权）
- 环境：腾讯云 Web 试用环境 `140.143.120.176`
- 代码基线：`main@3dc46cf`
- 发布目录：`/srv/kangmin-cli/releases/workbench-3dc46cf`
- 发布包 SHA-256：`2b3c6bd807f83835277e9e91fcdcfd416843242d07dd93ecbced6669e8ac67c6`

本次完成 Issue #281：管理后台工作台收敛为“今日待办 → 快捷新建 → 内容概览”，三条快捷入口直接打开文章、视频与 AI 知识资料的新建任务；初次服务端同步完成前不显示伪零状态。

## 步骤一：合并与门禁

实现 PR #296 的 `quality`（3 分 15 秒）与 `image`（39 秒）全绿后 squash 合并为 `3dc46cf`，源提交与合并提交文件树一致，Issue #281 自动关闭。完整 `cd src && npm run check`、开启截图的浏览器 E2E、sequential-thinking 与 `$km-review` 均通过，P0–P2 清零。

## 步骤二：生产副本预演

候选 release 使用正式 SQLite 在线备份副本和媒体副本在 8788 启动，`/live` 与后台为 200，副本 `quick_check=ok`、23 项迁移和八项业务计数不变。通过一次性开发管理员会话和远程管理 CLI，真实回读文章、视频、消息与 AI 知识四类服务端列表；候选管理 JS 命中三层工作台文案，JS/CSS 哈希与合并构建一致。

## 步骤三：备份与切换

切换前生成并验证正式备份：

`/srv/kangmin-cli/backups/kangmin-mvp-20260826-183848-before-workbench-3dc46cf.sqlite`

备份 `quick_check=ok` 后，通过临时符号链接原子替换 `/srv/kangmin-cli/app`；启动健康失败会自动回滚到 `file-management-880421f`。本次启动健康通过，旧 release 与正式备份保留回滚。

## 步骤四：上线后验证与清理

- 应用与 Nginx active，`NRestarts=0`，清理后仅 8787 监听；
- 公网 HTTPS 首页、`/admin`、`/live` 为 200；`/ready=503` 仍只有既有加密密钥未配置；
- 正式库与备份 `quick_check=ok`，23 项迁移和八项计数保持 `22/11/21/136/136/51/15/26`；
- 公网管理 JS/CSS 与本地合并构建 SHA-256 逐字节一致，并命中新工作台文案；
- 8788 transient service、候选库、候选媒体副本和服务器传输包已清理。

## 已知限制

- 当前试用环境仍使用 SQLite；`/ready` 的加密配置缺口不是本轮引入。
- 该记录证明工程门禁与 Web 试用环境可用，不替代客户视觉验收或医学批准。
