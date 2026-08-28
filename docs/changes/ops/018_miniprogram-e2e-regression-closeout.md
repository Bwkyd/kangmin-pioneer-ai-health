---
type: ops
number: "018"
date: 2026-08-28
title: 小程序逐页 E2E 回归修复预览与收尾
tags: [wechat, miniprogram, e2e, deploy, verification]
related: ["ops/017"]
---

# ops/018 小程序逐页 E2E 回归修复预览与收尾

## 执行概述

- 时间：2026-08-28
- 执行人：Codex；作者已明确授权测试、提交、PR、CI、合并、部署尝试、关闭 Issue 与分支收尾
- 实现：PR #381，已 squash 合并为 `main@1ea003d`
- 收尾记录：PR #382，已 squash 合并为 `main@e51d7e6`
- 状态校正：PR #383，已 squash 合并为 `main@70e8c77973c0ba68e626c26951ce6abbe00f58f0`，用于把最终主线、分支与收尾事实对齐
- 关闭 Issue：[#378](https://github.com/Bwkyd/kangmin-pioneer-ai-health/issues/378)、[#379](https://github.com/Bwkyd/kangmin-pioneer-ai-health/issues/379)、[#380](https://github.com/Bwkyd/kangmin-pioneer-ai-health/issues/380)

本轮修复了小程序网络不可用时暴露微信运行时错误、健康档案窄屏记录行溢出、我的页隐私/关于入口无行为三类回归，并补齐源码回归、页面用例和真实微信开发者工具复测。没有修改服务端运行时代码、数据库、患者数据、医学规则或 truth，因此不重复构建、切换或重启线上服务。

## 合并与验证

- PR #381 的 `quality` 与 `image` CI 均成功；合并后 `HEAD` 与 `origin/main` 均为 `1ea003db230090e2af63f9c4ea04522dd610412e`
- `cd src && npm run test:smoke:miniprogram`：4/4 通过
- 完整 `cd src && npm run check`：442 条 Node 测试中 364 条通过、78 条因本机未配置 PostgreSQL/S3 跳过、0 失败；管理端 2/2，真实 Chromium E2E 通过
- `python3 scripts/check-test-coverage-ledger.py .`、`python3 scripts/check-manifests.py`、`git diff --check`：通过
- staged gitleaks：通过；全仓扫描仍只命中任务前已有测试假 key，不属于本轮新增泄露
- `structure-lint` 仍只报告任务前已有的两个 `_work/` 中文目录名，未改动作者过程材料

## 真实小程序复测

微信开发者工具 36.6.0（核心 2.02.2608031）使用隔离临时工程和已授权 AppID，真实运行在 iPhone 12/13 模拟器 `390×753` 视口；只写入匿名本地 fixture，没有真实患者身份或健康数据上传。复测结果如下：

- “我的”页 6 个入口均可见；隐私弹层可打开、管理本机授权并关闭；关于弹层可打开并关闭
- 健康档案有 2 条匿名记录；编辑/删除操作按钮均在视口内，没有逐字竖排或右侧溢出
- “学一学”显示受控的未配置内容服务提示；“问助手”显示受控的未开放态，不暴露微信平台错误
- DevTools 异常计数为 0；截图证据保存在 `_work/20260828-miniprogram-e2e/`

## 微信预览与上传结果

按交付门禁先回读 `cli islogin`，再使用同一临时工程执行官方 CLI `preview` 和 `upload`。两条命令均返回 `41002 appid missing`，没有生成有效二维码或 `info-output` 文件，不能记为预览成功或开发版上传成功。

为排除 CLI 参数转发问题，又按当前开发者工具源码确认的 `/v2/preview`、`/v2/upload` 接口，显式传入 `project`、AppID、版本 `0.1.14`、描述和输出路径；两次仍在微信上传服务处返回 `41002 appid missing`。因此本轮没有继续修改业务代码绕过微信账号/工具绑定，也没有把退出码、临时项目或截图冒充部署完成。

当前结论是：客户端修复已合并并通过真实模拟器复测；微信开发版预览/上传被本机工具或当前账号的 AppID 绑定状态阻断。后续需在微信开发者工具/公众平台确认该账号的开发者权限与 AppID 绑定，再重新上传；合法 HTTPS request 域名仍需客户提供并在微信后台登记。

## 线上只读复核

本轮没有服务端运行时代码变化，不创建新 release、不切换 `/srv/kangmin-cli/app`、不重启 systemd。实时复核结果：

- `kangmin-cli.service`：`active`，`NRestarts=0`，运行入口为 `/srv/kangmin-cli/app/apps/kangmin-api/dist/server.js`
- 公网 `https://140.143.120.176/live`：HTTP 200，返回 `{"status":"ok"}`
- 公网 `/v1/meta`：HTTP 200，服务版本 `0.1.0`、协议版本 `1`、schema 版本 `1`
- 正式 SQLite `PRAGMA quick_check`：`ok`

这些证据只说明现有服务未被本轮客户端改动破坏，不等于小程序体验版可见、真机验收、微信审核、正式发布、客户验收或医学批准。

## 收尾边界

- #378 关闭的是“不可用网络入口暴露平台错误”的缺陷；没有宣称线上文章、视频或问助手已恢复
- #379、#380 已通过源码回归和真实模拟器路径验证并关闭
- 本地与远端任务分支在合并后按 Git 状态核验清理；作者原件 `hi.md` 保持未跟踪、未修改
- 真实微信账号绑定、合法域名、真机与体验成员验收、正式发布仍是外部待办
