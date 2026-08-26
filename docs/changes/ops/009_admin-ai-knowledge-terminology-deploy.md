---
type: ops
number: "009"
date: 2026-08-26
title: 管理后台 AI 知识库术语部署
tags: [admin, knowledge, terminology, ui, sqlite, deploy]
related: ["ops/008"]
---

# ops/009 管理后台 AI 知识库术语部署

## 执行概述

- 时间：2026-08-26
- 执行人：Codex（作者授权）
- 环境：腾讯云 Web 试用环境 `140.143.120.176`
- 代码基线：`main@fb4536e`
- 发布目录：`/srv/kangmin-cli/releases/ai-knowledge-fb4536e`
- 发布包 SHA-256：`17409db26fec86e2e2fbdebe89bfc675130d02ff3076407ec01bf43d7ff25dc0`

本次将管理后台运营可见的“智能体知识库”统一为“AI知识库”，并明确素材库保存原始文件，
只有登记为 AI 知识、建立索引并启用后才参与 AI 问答。后端命令、数据结构、知识生命周期、
患者端和医学规则均未改变。

## 步骤一：合并与门禁

PR #288 的 `quality`、`image` CI 通过后 squash 合并为 `fb4536e`，源分支与合并提交文件树
一致，Issue #278 自动关闭。Node 22.23.1 下完整 `src` 门禁通过，包含类型、架构、小程序
检查、构建、单元与契约测试和真实浏览器 E2E；清单、结构、差异格式和密钥扫描通过。

sequential-thinking 六步元反思和 `km-review` 三视角覆盖登录页、工作台、空状态、确认框、
面包屑、无障碍名称、390×844 导航几何和知识生命周期回归，P0–P2 清零。详细结论见
`docs/reviews/026_admin-ai-knowledge-terminology-review.md`。

## 步骤二：生产副本预演

候选 release 在独立 8788 端口使用正式 SQLite 在线备份副本预演。`/live`、后台页面、真实
管理命令和新管理 JS 通过；接口返回 26 条正式视频，新资源包含“AI知识库”和素材职责说明，
不含旧模块名。副本 `quick_check=ok`，八项数据计数保持 `22/11/21/136/136/51/15/26`。
预演结束后关闭 8788 并删除副本和日志。

## 步骤三：备份与切换

停止 `kangmin-cli.service` 后生成备份：

`/srv/kangmin-cli/backups/kangmin-mvp-20260826-165554-before-ai-knowledge-fb4536e.sqlite`

备份 `quick_check=ok` 后，将 `/srv/kangmin-cli/app` 原子切换到候选 release 并启动服务；切换
脚本配置失败自动恢复旧链接。旧发布目录 `/srv/kangmin-cli/releases/admin-video-pagination-ffc8628`
与本次数据库备份继续作为回滚材料保留。

## 步骤四：上线后实效验证

- `kangmin-cli` 与 Nginx 均为 `active`，应用 `NRestarts=0`，只监听内部 `127.0.0.1:8787`，
  8788 已关闭；
- 公网首页、`/admin`、`/live` 均返回 200；`/ready=503` 仍只因试用环境未配置加密密钥；
- 正式库和备份均为 `quick_check=ok`，数据计数和切换前一致；
- 管理 JS 的 SHA-256 与本地合并构建逐字节一致，除主动 `/ready` 探测外无新增错误；
- 传输包、本地打包目录、预演数据库和日志均已清理，正式备份与旧 release 保留回滚。

## 坑记录

候选首次安装依赖时直接调用固定路径下的 `npm`，但未把同目录加入子进程 `PATH`，`npm`
因 `/usr/bin/env node` 找不到 Node 而在预演前失败。补为
`PATH=/opt/node-v22.23.1/bin:$PATH npm ci --omit=dev` 后通过；正式流量和数据库未被触及。

## 已知限制

- 本轮证明新术语和旧生命周期在自动化与生产候选数据上可用，不等于客户人工验收。
- 正式配置加密密钥后仍需单独验证并恢复 `/ready` 200。
