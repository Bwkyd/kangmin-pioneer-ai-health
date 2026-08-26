---
type: ops
number: "015"
date: 2026-08-26
title: 内容分类注册表部署与小程序开发版上传
tags: [content, category, migration, miniprogram, deploy]
related: ["ops/014"]
---

# ops/015 内容分类注册表部署与小程序开发版上传

## 执行概述

- 时间：2026-08-26
- 执行人：Codex（作者授权）
- 实现：Issue #284、PR #300，squash 合并为 `main@bf44d26`
- Web release：`/srv/kangmin-cli/releases/category-registry-bf44d26`
- 发布包 SHA-256：`11bc8d75c93946aed5001b806bb157a72d4996786e04aa96e5411ead9ac0b471`
- 小程序：开发版 `0.1.13`，上传包体 826,647 字节

本次把文章与视频分类统一为服务端稳定注册表。文章只有一个面向全部人群的“科普文章”，时间仅用于排序；视频按人群、方案类别和细分类组成树，并允许一项视频显式关联多个叶节点。Web 与小程序只按稳定 ID 消费同一注册表。

## 合并与门禁

PR #300 首轮 CI 暴露 PostgreSQL 兼容契约中三处旧预期，修复后第二轮 `quality`（PostgreSQL 16、S3、完整门禁）与 `image` 全绿，Issue #284 自动关闭。最终本地 `src` 门禁共 438 项测试，360 项通过、78 项因未配置 PostgreSQL/S3 按约定跳过、0 失败，真实浏览器 E2E 通过；`legacy` 127 项全部通过。sequential-thinking 与 `$km-review` 复核后 P0–P2 为 0。

## 候选预演与数据库迁移

候选 release 在 8788 使用生产 SQLite 在线备份副本启动。安全启动守卫先因手工候选未带 systemd 的本地环境标记而拒绝启动，补齐与正式服务一致的非密钥环境变量后正常运行；拒绝发生在迁移前，未影响正式库。

候选库 `quick_check=ok`，迁移从 23 项增加到 24 项，最新为 `0022_content_category_registry`。分类注册表共 20 个节点、视频关联 38 条；26 条存量视频迁移报告均为 `migrated`，没有未决项，迁移前后内容 ID、发布状态和患者可见状态哈希一致。候选接口回读唯一文章分类 `article-general / 科普文章` 和完整视频树，患者首页、旧版 Web 管理端及 JS/CSS 哈希均通过复核。

## 正式切换与小程序上传

切换前生成并验证正式备份：

`/srv/kangmin-cli/data/backups/kangmin-mvp-20260826-225521-before-category-registry-bf44d26.sqlite`

通过临时符号链接原子切换 `/srv/kangmin-cli/app`，健康失败路径配置为回滚至 `learning-ae92710`；本次 `/live` 通过，未触发回滚。

从合并树创建全新临时小程序项目，只从任务前已有隔离项目复用已确认的 `project.config.json`。官方 CLI 回读 AppID `wxec3aeaadcddaf45e`，真实预览编译包体 779,701 字节；开发版 `0.1.13` 上传成功。仓库占位 AppID 和任务前已有隔离项目均未修改。

## 上线后验证与限制

- 应用与 Nginx active，正式服务 `NRestarts=0`，公网 HTTPS 首页、后台和 `/live` 为 200；
- 正式库 `quick_check=ok`，24 项迁移、20 个节点、38 条关联和 26 条成功迁移报告与候选一致；
- 26 条视频的 ID、发布状态和患者可见状态哈希与迁移前一致；
- 生产 Chromium 真实加载患者授权页和旧版管理登录页，无页面脚本异常；患者未授权会话探测返回预期 401；
- `/ready=503` 仍只因既有加密密钥未配置，数据库、对象存储、环境能力和规则包检查正常；
- 候选服务、候选数据库、传输包和新建小程序临时项目在记录完成后清理；旧 Web release 与正式数据库备份保留回滚。

开发版上传不等于体验版可见、真机视觉验收、微信审核、正式发布、医学批准或客户验收。
