---
type: ops
number: "019"
date: 2026-08-28
title: 小程序验收任务单交付收尾与反馈分流
tags: [wechat, miniprogram, issue, closeout, handoff]
related: ["ops/018"]
---

# ops/019 小程序验收任务单交付收尾与反馈分流

## 执行概述

- 时间：2026-08-28
- 执行人：Codex；作者明确授权按交付策略关闭现有任务单
- 代码基线：`main@876f7a2`
- 收尾记录：PR #406 已 squash 合并，合并提交为 `876f7a29ab468381a6a7623b878c80265b3d47ed`
- 范围：关闭 #385、#386、#387、#388，并保留客户后续反馈另开问题的分流约定

## 执行结果

四个小程序交付相关任务单均已关闭：

- [#385 正式工程配置、体验版上传与真机验收](https://github.com/Bwkyd/kangmin-pioneer-ai-health/issues/385)
- [#386 智能辨证调理助手正式联调与端到端验收](https://github.com/Bwkyd/kangmin-pioneer-ai-health/issues/386)
- [#387 症状评估正式身份接入、服务端保存与趋势验收](https://github.com/Bwkyd/kangmin-pioneer-ai-health/issues/387)
- [#388 科普文章、操作视频与应用内消息推送验收](https://github.com/Bwkyd/kangmin-pioneer-ai-health/issues/388)

每个任务单都追加了相同的边界说明：仓内实现、自动化验证和开发版上传工作已经完成；客户后续发现具体问题时新建 issue 跟踪修复。本次关闭是作者确认的交付管理策略，不把关闭状态扩大解释为逐项客户验收、体验版正式可见、真机验收或生产发布。

## 验证与清理

- `gh issue list --state all` 回读 #385–#388 均为 `CLOSED`
- `gh pr view 406` 回读为 `MERGED`
- `quality`、`image` CI 均通过
- `git rev-parse HEAD origin/main` 一致，均为 `876f7a29ab468381a6a7623b878c80265b3d47ed`
- `git fetch --prune origin` 后，本轮任务远端分支已删除；本地仅保留 `main` 工作树
- 独立的 Dependabot 远端分支和开放 PR 未纳入本轮清理
- `hi.md` 为作者原件，保持未跟踪、未修改

## 已知边界与后续

- 当前记录仍承接既有事实：自有 AppID 已完成开发版 `0.1.15` 上传和预览，但不等于体验版正式可见。
- 正式域名、微信正式身份链路、正式云资源、加密配置、真机和部署就绪性仍需按实际条件处理；公网 `/ready` 之前复核为 `503`。
- 客户反馈不复开历史任务单，按具体现象新建 issue，并在新 issue 中附复现步骤、环境、预期与实际结果。
