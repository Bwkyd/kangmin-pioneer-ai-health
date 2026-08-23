---
type: ops
number: "002"
date: 2026-08-24
title: 小程序同构首页开发版上传与服务复核
tags: [wechat, miniprogram, upload, verification]
related: ["ops/001", "experiments/021"]
---

# ops/002 小程序同构首页开发版上传与服务复核

## 执行概述

- 时间：2026-08-24
- 执行人：Codex；作者已明确授权提交、合并、部署与清理
- 环境：macOS、微信开发者工具 RC 2.02.2608031、合并基线 `main@f373375`
- 结果：开发版 `0.1.1` 上传成功，包体 180,689 字节；既有 Web 服务未重复部署且复核稳定

## 步骤一：合并前验证

首页实现经实验 021 收敛后，完整 `cd src && npm run check` 通过：412 项测试中 336 通过、
76 项因未配置 PostgreSQL/S3 按约定跳过、0 失败，真实 Chrome 患者与管理端 E2E 通过。
PR #257 的 `quality` 和 `image` 均成功，随后 squash 合并为 `f373375`。

## 步骤二：隔离上传副本

从合并后的 `src/miniprogram` 创建临时副本，只在副本的 `project.config.json` 注入已确认 AppID；
仓库工程继续保持空 AppID，未写入 AppSecret、患者数据或其他凭据。上传前 `cli islogin` 返回
`{"login":true}`。

## 步骤三：上传开发版

使用微信开发者工具 CLI 上传版本 `0.1.1`，描述为“患者 Web 同构首页”。CLI 返回 `upload`
成功，信息文件记录总包体 180,689 字节。本次 RC 工具已能直接完成上传，未复现 ops/001 中
旧版 CLI 的二维码输出参数缺陷。

## 步骤四：复核并收尾

本轮只改变微信小程序客户端，不改变 Web 服务端构建、数据库或运行配置，因此没有创建无意义
的服务器 release。腾讯云仍运行 `/srv/kangmin-cli/releases/plan-video-complete-a43cc72`：应用与
Nginx active、`NRestarts=0`、SQLite `quick_check=ok`；公网首页、后台和 `/live` 均为 200。
`/ready=503` 仍只因试用环境既有加密配置未完成。

上传副本、开发者工具测试副本和临时自动化依赖均移入本机废纸篓，可恢复；开发者工具退出后
复核 49606、13005、61103 端口均无监听。仓库仅配置 GitHub `origin`；CNB 登录有效，但按
`kangmin` 与 `pioneer` 查询均为 0 个可见仓库，因此没有可验证或可删除的 CNB 任务分支。

## 坑记录

### 2026 RC 与官方自动化 SDK 协议不兼容

`miniprogram-automator@0.12.1` 先在工具版本比较处读取未定义值，临时绕过后又等待协议响应超时。
本次只把开发者工具真实编译、WXML 挂载、控制台与上传接口作为证据，不把失败的 SDK 自动化
冒充端到端或真机视觉验收。

## 后续 TODO

- [ ] 配置微信登录和合法域名后验证真实身份及失败路径
- [ ] 由体验成员在真机核对首页视觉、滚动、安全区与全部入口
- [ ] 客户确认后再进入提审与正式发布；开发版上传不等于微信审核通过
