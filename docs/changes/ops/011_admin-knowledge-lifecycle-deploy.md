---
type: ops
number: "011"
date: 2026-08-26
title: 管理后台知识资料生命周期部署
tags: [admin, knowledge, lifecycle, sqlite, deploy]
related: ["ops/010"]
---

# ops/011 管理后台知识资料生命周期部署

## 执行概述

- 时间：2026-08-26
- 执行人：Codex（作者授权）
- 环境：腾讯云 Web 试用环境 `140.143.120.176`
- 代码基线：`main@0f4527f`
- 发布目录：`/srv/kangmin-cli/releases/knowledge-lifecycle-0f4527f`
- 发布包 SHA-256：`c005e72f65adfd07ebabcd3a2a4a6a0e2f4d0152a9be30cfcc281214ddfa7889`

本次把 AI 知识资料的上传、自动索引、单资料检索测试与运营明确启用收进连续任务；换文件
保留知识 ID，原子替换素材元数据、正文分块与向量并重置旧启用状态。知识列表改为每页 20 条，
每个状态只突出唯一下一步。

## 步骤一：合并与门禁

实现 PR #292 的 `quality`（含真实 PostgreSQL 契约）与 `image` CI 全绿后 squash 合并为
`0f4527f`，源提交与合并提交文件树一致，Issue #276 自动关闭。Node 22.23.1 下完整 `src`
门禁 430 项中 352 通过、78 项因本地未配置 PostgreSQL/S3 跳过、0 失败；真实浏览器 E2E
覆盖 25 条分页、连续任务、换文件上传失败同文件重试和旧患者/内容链路。

`km-review` 发现全库旧命中可能串入新增或换文件任务这一 P1；清空两个任务边界的查询证据并
补齐两种变式后，sequential-thinking 六步复核和三视角评审均为 P0–P2 清零。

## 步骤二：生产副本预演

候选 release 在 8788 使用正式 SQLite 在线备份副本启动，`/live`、后台、`quick_check=ok`
和 23 项迁移通过。真实 HTTP 链路完成两次上传票据，以及创建、索引、按 ID 测试、明确启用、
换文件后全库排除、重新索引/测试/启用、停用和删除；临时知识清零，核心数据恢复基线。

## 步骤三：备份与切换

切换前生成并验证备份：

`/srv/kangmin-cli/backups/kangmin-mvp-20260826-174933-before-knowledge-lifecycle-0f4527f.sqlite`

备份 `quick_check=ok` 后，通过临时符号链接原子替换 `/srv/kangmin-cli/app`；启动脚本配置健康
失败自动回滚到 `inline-uploads-7c19bcb`。本次启动健康通过，旧 release 与正式备份继续保留。

## 步骤四：上线后验证

- 应用与 Nginx active，`NRestarts=0`，仅 8787 监听，8788 和候选数据已清理；
- 公网首页、`/admin`、`/live` 为 200；`/ready=503` 仍只因既有加密密钥未配置；
- 正式库与备份 `quick_check=ok`，23 项迁移和八项计数均为
  `22/11/21/136/136/51/15/26`；
- 公网管理 JS/CSS、release 与本地合并构建 SHA-256 逐字节一致，新生命周期文案均存在；
- 部署后两条 error 日志均来自主动 `/ready` 探测，没有新增业务错误。

## 坑记录

服务器未安装 `jq`，首版预演脚本在解析临时管理员令牌时停止；改用服务器已有 Node 22 原生
JSON 与 `fetch`。第二版按命令路由使用 Bearer 调用上传 PUT，被同源上传路由按设计拒绝；改为
HttpOnly 管理 Cookie 后完整链路通过。两次都发生在正式切换前，前者只新增副本会话，后者只
留下副本中的 uploading 素材；候选目录随预演统一清理，正式库未受影响。

## 已知限制

- 本轮证明工程门禁与 Web 试用环境可用，不等于客户人工验收或医学批准。
- 上传成功但换文件因版本冲突被拒绝时保留独立素材；文件管理与引用去向继续由 #279 完成。
