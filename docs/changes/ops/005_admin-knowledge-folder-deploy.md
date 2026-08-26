---
type: ops
number: "005"
date: 2026-08-26
title: 管理后台知识目录树部署
tags: [admin, knowledge, sqlite, deploy]
related: ["plan/008"]
---

# ops/005 管理后台知识目录树部署

## 执行概述

- 时间：2026-08-26
- 执行人：Codex（作者授权）
- 环境：腾讯云 Web 试用环境 `140.143.120.176`
- 代码基线：`main@dcc91d9`
- 发布目录：`/srv/kangmin-cli/releases/knowledge-folders-dcc91d9`
- 发布包 SHA-256：`7fe5bfbc8406c7f33f4b8887f3b34f7c31f0afe261cbd1c5b541253ef6fc58b1`

本次把管理后台知识库的三级目录树、知识移动和兼容迁移部署到试用环境。目录仅用于运营整理，未改变患者侧检索、确定性医学规则或既有知识启停状态。

## 步骤一：合并与门禁

实现 PR #268 经 `quality`、`image` CI 通过后 squash 合并为 `1d16bd9`。部署预演发现真实 CLI 无法解析四段命令，停止生产切换；修复 PR #269 补齐最长命令前缀解析和真实进程 E2E，两项 CI 再次通过后 squash 合并为 `dcc91d9`。

合并前完整 `src` 门禁共 425 项：348 通过，77 项因本机未配置 PostgreSQL/S3 按约定跳过，0 失败；真实浏览器 E2E、`legacy` 127/127、差异密钥扫描和 `git diff --check` 通过。`km-review` 的患者可懂性、工程事实和医学安全三视角 P0–P2 均为 0。

## 步骤二：生产副本预演

在独立 8788 端口使用线上 SQLite 备份预演：迁移、后台页面、静态资源、三级目录 CRUD、第四级拒绝和 CLI 真入口均通过。知识、分块和向量数量保持 `21/136/136`，数据库 `quick_check=ok`，未改正式流量。

预演门禁先后拦住未继承试用环境开关、服务器缺少 `jq`、`pipefail` 下短路，以及四段 CLI 命令不可达；前三项修正预演脚本，CLI 缺陷则回到代码 PR 修复并重跑完整门禁，没有带病切换。

## 步骤三：备份与切换

停止 `kangmin-cli.service` 后，以 SQLite 在线一致性机制生成备份：

`/srv/kangmin-cli/backups/kangmin-mvp-20260826-123047-before-knowledge-folders-dcc91d9.sqlite`

备份 `quick_check=ok` 后，将 `/srv/kangmin-cli/app` 原子切换到新发布目录并启动服务。旧发布目录 `/srv/kangmin-cli/releases/plan-video-complete-a43cc72` 与数据库备份保留为回滚材料。

## 步骤四：上线后实效验证

- systemd 为 `active/running`，`NRestarts=0`；
- 公网首页、`/admin`、`/live` 均返回 200；
- 公网管理后台资源 SHA-256 与发布目录一致，并包含知识目录界面；
- 通过公网 `/v1/admin/commands` 真实创建三级目录，第四级按设计拒绝，随后反向删除目录并注销临时管理员会话；
- 正式库 `quick_check=ok`，迁移 `0021_knowledge_folders` 已应用，知识/分块/向量仍为 `21/136/136`，临时目录残留为 0；
- 8788 预演监听已关闭。`/ready` 仍为既有 503，仅因试用环境未配置加密密钥，不是本次回归。

## 坑记录

### 问题

单元调用能执行目录命令，但真实 CLI 原来只拼接三个命令段，四段的 `agent knowledge folder ...` 永远无法命中。

### 解决方案

解析器改为在已注册命令表中匹配最长前缀；E2E 改为启动真实 CLI 进程并贯通创建、改名、列表、知识归档、移动和删除，避免只测应用层造成假绿。

## 后续 TODO

- [ ] 由作者或客户在真实业务资料上验收目录命名与操作习惯。
- [ ] 正式配置加密密钥后恢复 `/ready` 200，并按独立运维变更验证。
