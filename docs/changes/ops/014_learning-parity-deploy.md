---
type: ops
number: "014"
date: 2026-08-26
title: 学一学人群分类修复与小程序开发版上传
tags: [learning, miniprogram, audience, deploy]
related: ["ops/004", "ops/013"]
---

# ops/014 学一学人群分类修复与小程序开发版上传

## 执行概述

- 时间：2026-08-26
- 执行人：Codex（作者授权）
- Web 基线：PR #298 squash 合并为 `main@ae92710`
- Web release：`/srv/kangmin-cli/releases/learning-ae92710`
- 发布包 SHA-256：`c1d0ac60e877c6300daa553b03798b6fe0057b9346424a98a10ae8e547153a20`
- 小程序：开发版 `0.1.12`，上传包体 828,856 字节

本次完成 Issue #283：Web 与小程序按明确成人/儿童分类排他展示视频，分类缺失或未知时仅允许全目录唯一标题兜底；小程序稳定为“学一学”四入口、目录内视频列表和五项主导航。

## 合并与门禁

PR #298 的 `quality`（3 分 31 秒）与 `image`（40 秒）全绿，源提交和 squash 合并提交文件树一致，Issue #283 自动关闭。完整 `cd src && npm run check`、真实浏览器 E2E、分类/小程序窄测、密文测试 100 次复跑、sequential-thinking 与 `$km-review` 均通过，P0–P2 为 0。

## 小程序预览与上传

从任务前已有隔离项目只复制 `project.config.json` 和私有项目设置到全新临时目录，再从合并树同步小程序源码并排除身份配置。微信开发者工具 CLI 回读 AppID `wxec3aeaadcddaf45e` 后真实预览编译成功，预览包体 781,547 字节；开发版 `0.1.12` 上传成功。临时项目和二维码已清理，任务前已有的两个隔离项目未触碰。

## Web 候选预演与切换

候选 release 在 8788 使用正式 SQLite 在线备份副本和媒体副本启动，`/live` 正常、无 warning、`NRestarts=0`。候选库 `quick_check=ok`、23 项迁移与八项计数 `22/11/21/136/136/51/15/26` 不变；匿名命令真实回读 26 个已发布视频，覆盖儿童调体、儿童快速通窍、成人症状护理、成人调体和成人快速通窍。候选 JS/CSS 与合并构建 SHA-256 一致。

切换前生成并验证正式备份：

`/srv/kangmin-cli/backups/kangmin-mvp-20260826-190409-before-learning-ae92710.sqlite`

通过临时符号链接原子切换 `/srv/kangmin-cli/app`，健康失败路径配置为回滚至 `workbench-3dc46cf`；本次健康检查通过，未触发回滚。

## 上线后验证与限制

- 应用与 Nginx active，`NRestarts=0`，清理后仅 8787 监听；
- 公网 HTTPS 首页、后台和 `/live` 为 200，新 JS/CSS 哈希与合并构建一致；
- 公网匿名 API 回读 26 个视频及五类成人/儿童分类；
- 正式库和备份 `quick_check=ok`，23 项迁移及八项计数不变；
- `/ready=503` 仍只因既有加密密钥未配置；
- 候选服务、数据库/媒体副本、传输包、验证响应和新建小程序临时项目均已清理。

开发版上传不等于体验版可见、真机视觉验收、微信审核、正式发布、医学批准或客户验收。旧 Web release 和正式数据库备份保留回滚。
