---
type: ops
number: "007"
date: 2026-08-26
title: 管理后台视频预览尺寸与文案修复部署
tags: [admin, video, preview, ui, sqlite, deploy]
related: ["ops/006"]
---

# ops/007 管理后台视频预览尺寸与文案修复部署

## 执行概述

- 时间：2026-08-26
- 执行人：Codex（作者授权）
- 环境：腾讯云 Web 试用环境 `140.143.120.176`
- 代码基线：`main@b0b18a3`
- 发布目录：`/srv/kangmin-cli/releases/admin-video-preview-b0b18a3`
- 发布包 SHA-256：`123753176232bd97536afce3f0340f62a7406503b1872b64ba7d12cde54ab235`

本次将管理后台内容列表中的“校验”操作改为“预览”，并限制预览弹层内视频的宽高，避免竖屏视频超出视口。服务端发布前校验、校验结果提示、上下架链路和医学内容均未改变。

## 步骤一：合并与门禁

PR #275 的 `quality`、`image` CI 通过后 squash 合并为 `b0b18a3`。完整 `src` 门禁通过，包含类型、架构、小程序检查、构建、单元/契约测试和真实浏览器 E2E；`legacy` 127/127、清单检查、差异密钥扫描和 `git diff --check` 通过。

sequential-thinking 八步元反思和 `km-review` 三视角发现首版只验证 CSS 声明、未验证实际视口边界这一 P2，补齐 `390×844` 与 `1440×1000` 两种视口下的实际宽高、不裁切、旧“校验”按钮消失及发布前校验提示保留断言后，P0–P2 清零。详细评审见 `docs/reviews/024_admin-video-preview-meta-review.md`。

## 步骤二：生产副本预演

候选 release 在独立 8788 端口使用线上 SQLite 在线备份副本预演。`/live`、后台页面、真实视频列表与实际已发布视频预览 API 均通过；管理 CSS 含新尺寸约束，管理 JS 含新预览文案。副本 `quick_check=ok`，八项数据计数保持 `21/11/21/136/136/51/15/26`。预演结束后关闭 8788 并删除数据库副本和日志。

## 步骤三：备份与切换

停止 `kangmin-cli.service` 后生成备份：

`/srv/kangmin-cli/backups/kangmin-mvp-20260826-153151-before-admin-video-preview-b0b18a3.sqlite`

备份 `quick_check=ok` 后，将 `/srv/kangmin-cli/app` 原子切换到候选 release 并启动服务；切换脚本配置失败自动恢复旧链接。旧发布目录 `/srv/kangmin-cli/releases/knowledge-ui-fc2f992` 与本次数据库备份继续作为回滚材料保留。

## 步骤四：上线后实效验证

- `kangmin-cli` 与 Nginx 均为 `active`，应用 `NRestarts=0`，只监听内部 `127.0.0.1:8787`，8788 已关闭；
- 公网首页、`/admin`、`/live` 均返回 200，三份管理 JS/CSS 的 SHA-256 与合并后本地构建逐字节一致；
- 正式库和本次备份均为 `quick_check=ok`，23 项迁移及八项数据计数完全一致；
- 日志只有 Node SQLite 已知实验性提示，以及主动访问 `/ready` 产生的既有 503；该接口唯一未就绪项仍是试用环境未配置加密密钥；
- 候选传输包、本地打包目录、预演数据库和日志均已清理，正式备份与旧 release 保留回滚。

## 坑记录

### 问题

候选 release 首次安装依赖时，非交互 SSH 环境的 `PATH` 不包含固定 Node 目录；首次 8788 验证又假设服务器已安装 `jq`。两次都在切换正式流量前失败并由清理 trap 收口，没有修改正式服务或数据库。

部署后本地公网检查曾把 zsh 特殊数组名 `path` 用作循环变量，导致当前 shell 临时找不到 `curl`；改为任务专用变量后验证通过，远端服务未受影响。

### 解决方案

部署命令显式使用 `/opt/node-v22.23.1/bin`，JSON 断言改用服务器已有的 Python 标准库；shell 脚本只使用带任务前缀的变量名。正式切换仅在独立端口预演、数据副本和资源检查全部通过后执行。

## 后续 TODO

- [ ] 由作者或客户在实际运营账号下确认竖屏、横屏视频的视觉尺寸与操作文案。
- [ ] 正式配置加密密钥后恢复 `/ready` 200，并按独立运维变更验证。
