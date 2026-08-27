---
type: arch
number: "006"
date: 2026-08-27
title: src 采用应用与能力包的最小分形工作区
tags: [workspace, architecture, cli, complexity]
related: []
---

# arch/006 src 采用应用与能力包的最小分形工作区

## 背景与动机

旧 `src/` 把应用入口、业务模块、数据库、外部适配器和测试并列成十多个顶层目录。同一项改动需要
先理解多种目录规则，CLI、HTTP 与组合根也能绕过边界直接连接实现。患者 Web 已退役后继续保留两套
前端入口，只会增加确认成本。此次目标不是重写业务，而是让已有实现采用同一套可机械识别的小结构。

## 技术选型

| 方案 | 结果 |
| --- | --- |
| 只给旧目录改名 | 入口变短但依赖方向不受约束，放弃 |
| 按素材、草稿、定稿划分 | 不符合软件制品的职责与生命周期，放弃 |
| `apps / packages / scripts / tests` + 统一 workspace 小壳 | 采用；顶层固定，应用与能力各自同构 |

## 架构设计

- `src/` 的运行相关顶层目录精确收敛为 `apps`、`packages`、`scripts`、`tests`；构建产物和依赖目录不计入结构。
- 应用层固定为管理后台、API、CLI、微信小程序四个 workspace；旧患者 Web 删除，根网址与 `/admin` 都进入同一个管理后台。
- 能力层固定为 core、database、integrations、runtime 四个 workspace。core 内按患者、智能、内容、运营四组业务能力组织；database 统一 SQLite/PostgreSQL 契约；integrations 承接外部系统；runtime 只负责组合。
- 每个 workspace 都有 `package.json`、`README.md`、`src/`、`tests/` 同一小壳。应用只能经包导出使用能力，CLI/API 不得绕过 runtime 直连数据库或外部适配器。
- 根构建、检查、测试、Docker 与 CI 使用当前 workspace 入口；旧 `dist/app`、`dist/cli`、`dist/dev`、`dist/http` 入口由机械门禁拒绝。
- 迁移白名单在最后一项旧目录消失后删除。以后新增 `src` 顶层目录属于协议变更，不能静默放宽。

## 相关文件

- `src/package.json` — 单一构建、检查、测试和 CLI 入口。
- `src/apps/` — 四个可运行应用。
- `src/packages/` — 四个可复用能力包。
- `src/scripts/architecture-check.mjs` — workspace 依赖方向与顶层结构门禁。
- `src/scripts/check-final-workspace.mjs` — 最终目录、统一小壳和交付入口检查。
- `src/scripts/clean-dist.mjs` — 构建前清除根目录及所有 workspace 陈旧产物。

## 验证与限制

迁移按小程序、后台、core、database、integrations、runtime/CLI/API 分六个可回退交付完成；每轮均运行四组冒烟、窄测、完整 Node 测试和真实 Chromium E2E。最终轮还必须由 PostgreSQL、S3、OCI 镜像、生产依赖审计与 SBOM 的 CI 结果放行，并在部署前进行候选进程和回滚演练。

该结构降低的是找入口和确认依赖范围的复杂度，不承诺自动减少业务代码，也不把目录变整齐冒充功能变好。迁移期间因每个 workspace 增加小壳，导航指标曾轻微上升；超 600 行文件仍须按独立 Issue 在有真实变化轴时逐个实验，不能靠机械拆文件或增加小文件稀释占比。
