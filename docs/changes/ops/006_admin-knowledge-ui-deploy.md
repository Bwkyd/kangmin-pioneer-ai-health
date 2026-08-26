---
type: ops
number: "006"
date: 2026-08-26
title: 管理后台知识库界面精简部署
tags: [admin, knowledge, ui, sqlite, deploy]
related: ["ops/005"]
---

# ops/006 管理后台知识库界面精简部署

## 执行概述

- 时间：2026-08-26
- 执行人：Codex（作者授权）
- 环境：腾讯云 Web 试用环境 `140.143.120.176`
- 代码基线：`main@fc2f992`
- 发布目录：`/srv/kangmin-cli/releases/knowledge-ui-fc2f992`
- 发布包 SHA-256：`9a9a8f037c14ae3810344b85955081d6e269708a461fb43507fdb8a1b05821d0`

本次精简管理后台知识库页面：上传改为按需弹层，目录移动和检索测试降为按需操作，移除重复标题、常驻上传表单、分块技术列及重复状态说明；窄屏列表改为卡片。停用增加确认，取消上传会清空文件、来源与目录。知识、检索和医学规则均未改变。

## 步骤一：合并与门禁

PR #272 的 `quality`、`image` CI 通过后 squash 合并为 `fc2f992`。完整 `src` 门禁共 425 项：348 通过，77 项因本机未配置 PostgreSQL/S3 按约定跳过，0 失败；真实浏览器 E2E、`legacy` 127/127、生产依赖审计、差异密钥扫描和 `git diff --check` 通过。

sequential-thinking 元反思和 `km-review` 三视角复核发现并修复窄屏网格拉伸、表格拥挤、停用无确认及取消后表单残留的变式，最终 P0–P2 为 0。真实浏览器 E2E 覆盖上传取消重开、上传、编辑、移动、索引、启停确认、检索和删除，另对桌面与移动端截图做了目视复核。

## 步骤二：生产副本预演

候选发布在独立 8788 端口使用线上 SQLite 副本预演，后台页面、静态资源和真实管理命令列表均通过；数据库 `quick_check=ok`，知识、分块和向量保持 `21/136/136`。预演完成后关闭 8788 并删除副本，没有触及正式流量。

## 步骤三：备份与切换

停止 `kangmin-cli.service` 后生成备份：

`/srv/kangmin-cli/backups/kangmin-mvp-20260826-144738-before-knowledge-ui-fc2f992.sqlite`

备份 `quick_check=ok` 后，将 `/srv/kangmin-cli/app` 原子切换到新发布目录并启动服务；脚本在失败时会自动切回旧发布。旧发布目录 `/srv/kangmin-cli/releases/knowledge-folders-dcc91d9` 与数据库备份保留为回滚材料。

## 步骤四：上线后实效验证

- `kangmin-cli` 与 Nginx 均为 `active`，应用 `NRestarts=0`，仅监听内部 `127.0.0.1:8787`；
- 公网首页、`/admin`、`/live` 均返回 200；公网管理 JS 与合并后本地构建逐字节一致；
- 正式库和本次备份均为 `quick_check=ok`；
- 实时数量为 21 位患者、11 个启用方案、21 份知识、136 个知识切块、136 个向量、51 个会话、15 份评估和 26 条已发布视频，与切换前一致；
- 发布后服务 warning 日志无新增记录，8788 已关闭，候选传输包和预演脚本已删除；
- `/ready` 仍为既有 503，唯一阻塞项是试用环境未配置加密密钥，不是本次回归。

## 坑记录

### 问题

上线后第一次人工复核误用了不存在的 `/srv/kangmin-cli/shared/data/` 路径，命令无法打开数据库。

### 解决方案

以 systemd 的 `KANGMIN_DB_PATH=/srv/kangmin-cli/data/kangmin-mvp.sqlite` 为运行事实重新核验；正式部署脚本原本已经使用正确路径，未造成数据或服务变更。

## 后续 TODO

- [ ] 由作者或客户使用真实业务资料验收简化后的操作层级。
- [ ] 正式配置加密密钥后恢复 `/ready` 200，并按独立运维变更验证。
