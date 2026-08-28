---
type: review
number: "049"
date: 2026-08-28
title: 整体发车合并后收口复核
tags: [launch, closeout, admin, verification]
related: ["reviews/048", "experiments/041"]
---

# reviews/049 整体发车合并后收口复核

## 结论

仓内管理后台 G1–G3 已由 PR [#398](https://github.com/Bwkyd/kangmin-pioneer-ai-health/pull/398)
修复并 squash 合并到 `main@fa09f63`，收口文档再由 PR #399 合并，最终主分支为
`main@529dd68`；记录校正 PR #400 随后合并，当前主分支为 `main@cf85d4c`；#390–#397 已逐条关闭。
合并前 PR quality/image、三次收口 PR 的 main push CI 均通过；本轮没有发现新的仓内 P0–P2。

这不是正式整体生产就绪结论：试运行部署尚未切换，当前远程 SSH 公钥被拒；正式
PostgreSQL、COS、加密密钥、微信 AppID/权限/合法 HTTPS 域名、双平台真机及客户/医学负责人
验收仍由 #385–#388 追踪。

## 患者与医学安全视角

- 内容编辑、公告发布、知识检索和管理员认证的修复不改变问卷、证型、期别、方案、禁忌或 `vault/truth/`。
- 事务失败、会话失效、未可信代理来源和未知状态仍按 fail-closed 处理；已发布内容改稿会先回到草稿。
- 试运行公网只读复核为 `/live=200`、`/v1/meta=200`、`/ready=503`；`ready` 明确报未配置加密密钥，不能把它解释为正式可用。
- 患者/客户和医学负责人仍需对真实内容、微信身份链路和真机体验做实效验收；自动化测试不替代该验收。

## 工程与交付视角

- 本地：`src` 完整检查 506 条 Node 测试 494 通过、0 失败、12 条只因未注入 S3 跳过；管理端 6/6、真实 Chromium E2E 通过；本机 PostgreSQL 127/127、官方 MinIO S3/远程上传 12/12、legacy 127/127。
- GitHub：PR #398 的 quality 4分36秒、image 59秒通过；其合并后 main CI run `33150513262` 的 quality 4分21秒、image 57秒通过。收口 PR #399 的 quality 4分09秒、image 58秒及最终 main CI run `33151411204` 的 quality 4分14秒、image 1分03秒均通过；这些流水线包含结构/清单、MinIO、Playwright、完整 CLI、业务预验收、OCI、生产依赖审计和 SBOM。
- 首轮 CI 曾发现 GitHub checkout 不含私密 `vault/` 的真实门禁缺口，已用显式 `--allow-missing-private` 修复；本机无参数模式仍严格检查。
- staged gitleaks 0 命中；legacy 保留既有 2 条 moderate PostCSS/Next advisory，属于退役参考区 P3，不扩大为当前运行时已修复或零风险。
- 本地 `main` 与 `origin/main` 均为 `cf85d4c`，PR #398–#400 的 feature 远端分支已删除；工作区只保留作者原件 `hi.md`，未纳入提交。

## 外部状态与剩余门

1. 当前试运行服务继续保持既有 release；本机对 `chenqiqiang@140.143.120.176` 的受控 SSH 连接返回 `Permission denied (publickey,...)`，因此没有盲试口令或无关私钥，也没有执行备份、上传、切换或重启。
2. #385–#388 仍为 OPEN/blocked；需要作者/客户提供正式云资源、微信配置和真实验收条件后再继续。
3. 本轮可交付边界是“仓内代码已合并、CI 通过、管理后台缺陷已关闭”，不是“部署完成、客户验收完成、临床批准或正式发布完成”。
