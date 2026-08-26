---
type: ops
number: "010"
date: 2026-08-26
title: 管理后台文章与视频表单内上传部署
tags: [admin, upload, article, video, sqlite, deploy]
related: ["ops/009"]
---

# ops/010 管理后台文章与视频表单内上传部署

## 执行概述

- 时间：2026-08-26
- 执行人：Codex（作者授权）
- 环境：腾讯云 Web 试用环境 `140.143.120.176`
- 代码基线：`main@7c19bcb`
- 发布目录：`/srv/kangmin-cli/releases/inline-uploads-7c19bcb`
- 发布包 SHA-256：`9ec018c9b670369b3f86a3c14a77faa5dfea95e0c05ca5b2b19fca17ec08f122`

本次隐藏管理后台一级“素材库”入口，把文章正文图片/附件、文章封面、视频文件和视频封面
上传收进对应业务表单；底层文件、引用与上传协议保持不变。Issue #279 的文件管理和引用
能力仍待后续有界子轮完成，本次不关闭该 Issue。

## 步骤一：合并与门禁

实现 PR #290 的 `quality` 与 `image` CI 全绿后 squash 合并为 `7c19bcb`，源提交与合并提交
文件树一致。Node 22.23.1 下完整 `src` 门禁通过，包含真实浏览器上传失败、同文件重试、
文章附件兼容、患者预览和旧业务回归；清单、结构、差异格式和密钥扫描通过。

sequential-thinking 六步元反思发现首版误把正文附件收窄为仅图片，修复后保留 PDF、Word、
Markdown、TXT；`km-review` 三视角复核后 P0–P2 为 0，详见
`docs/reviews/027_admin-inline-upload-review.md`。

## 步骤二：生产副本预演

候选 release 在独立 8788 端口使用正式 SQLite 在线备份副本预演。`/live`、后台页面、开发
管理员会话、真实管理命令和新 JS/CSS 资源通过，接口返回 26 条正式视频；副本
`quick_check=ok`，23 项迁移与正式库一致。预演结束后关闭 8788 并清理副本和日志。

## 步骤三：备份与切换

切换前生成并校验备份：

`/srv/kangmin-cli/backups/kangmin-mvp-20260826-171400-before-inline-uploads-7c19bcb.sqlite`

备份 `quick_check=ok` 后，将 `/srv/kangmin-cli/app` 原子切换到候选 release 并启动服务；切换
脚本配置失败自动恢复旧链接。旧发布目录 `ai-knowledge-fb4536e` 与本次备份继续保留回滚。

## 步骤四：上线后验证

- 公网首页、`/admin`、`/live` 均为 200；`/ready=503` 仍只因试用环境未配置加密密钥；
- 应用与 Nginx 均 active，`NRestarts=0`，仅内部 8787 在监听，8788 已关闭；
- 正式库与备份 `quick_check=ok`，23 项迁移和八项计数保持
  `22/11/21/136/136/51/15/26`；
- 管理 JS/CSS 的 SHA-256 与本地合并构建逐字节一致，新增上传入口资源存在；
- 除两次主动 `/ready` 探测外无新增错误，传输包、预演数据库与日志已清理。

## 坑记录

首次预演从 `/etc/kangmin-cli.env` 假设数据库路径，但路径实际由 systemd unit 的
`Environment=KANGMIN_DB_PATH=...` 提供，预演在备份前安全停止。改为从真实 unit 核实路径后
通过。首次公网复核又假设了不存在的域名，随后按 Nginx 的默认 IP 入口重测通过；正式应用
始终健康。另一次本地循环误用 zsh 特殊变量 `path` 导致命令查找路径被覆盖，改用
`endpoint_path` 后验证通过。

## 已知限制

- 本轮证明表单内上传在自动化与生产候选数据上可用，不等于客户人工验收。
- Issue #279 尚未完成文件管理与引用闭环，待后续轮次实现后再关闭。
