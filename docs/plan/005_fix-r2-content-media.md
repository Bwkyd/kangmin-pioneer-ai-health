# 005 修复 Issue R2：内容媒体域（写路径校验 + 患者读路径投影）

> ✅ 已落地：Issue #151 → PR #152，squash 合入 main `fda50bd`（2026-08-03）。下文为开工前方案，行号证据基于旧基线，仅作档案留存。

> 来源：[`../reviews/002_cli-dev-status-adversarial-review.md`](../reviews/002_cli-dev-status-adversarial-review.md) P0-2、P0-3、P1-9
> 同类病：内容从管理端到患者端的链路上，校验和投影各缺一段。
> 复杂度：中｜建议分支：`codex/issue-<n>-content-media`

## 问题与证据

### 1. `updatePlan` 绕过启用校验（P0-3）

- `src/modules/agent-admin/agent-admin-service.ts:508-557`：更新只做 syndrome/video 存在性校验，且 `...current` 保留 `enabled` 状态
- 完整校验 `validatePlanForEnable`（:838）只在 `enablePlan`（:559）执行
- 后果：enabled 方案可被清空必填内容、换成未发布视频，"状态 enabled、内容已不安全"

### 2. 患者端方案不投影临床字段（P1-9）

- `src/infrastructure/sqlite-content-read-repository.ts:253-266`：`findPlan` 只 SELECT `id, name, revision, method, steps_json`
- `src/modules/browse/contracts.ts:39` 的 CarePlanDetail 缺 风险/禁忌/注意事项/关联视频（`agent_plans` 表 0009 迁移已有这些列，数据在库里但没投影）

### 3. 媒体交付链断裂 + 泄露服务器路径（P0-2）

- `src/modules/admin/content-aux-service.ts:131-137`：素材复制到本地目录，存 `stored_path`
- `src/infrastructure/sqlite-content-admin-repository.ts:258-259`：发布时 `cover_url/media_url = stored_path`（服务器绝对路径）直接暴露给患者
- `src/http/server.ts` 只有 3 个静态资源路由，无媒体路由 → 患者拿到不可播放且泄露目录结构的路径

## 范围

1. `updatePlan`：目标方案当前为 enabled 时，更新后重跑 `validatePlanForEnable`，校验失败拒绝更新（保持原子）
2. browse 契约 + 只读仓储投影补齐：`risks`、`contraindications`、`precautions`、关联视频引用
3. 发布时 `cover_url/media_url` 改写公开引用（`/v1/media/<media-id>` 形式），不再写绝对路径
4. HTTP 增加媒体路由：`GET /v1/media/:id` 按 id 读 `content_resource_media` 发文件（mime 白名单、防路径穿越、仅已发布内容的关联媒体可公开）
5. 旧库已有绝对路径数据兼容：读取时识别旧格式或写一次性迁移

## 非范围

- 对象存储接入（后续阶段）
- 危险方法自由文本识别改造（MSAF 语义待临床裁决，保持现状记录）
- 视频下架对已启用方案的级联停用（D4，另立 P1 任务）

## 验收标准

- enabled 方案清空 steps 或换未发布视频 → `validation_failed`；draft 方案更新行为不变
- `browse plan show --json` 输出含 risks/contraindications/precautions/video 字段（开关打开时）
- 发布后患者侧 `media_url` 为 `/v1/media/<id>` 形式，不含任何服务器绝对路径
- 通过 HTTP 可获取已发布视频文件（正确 Content-Type）；未发布/不存在 id 返回 404；`../` 穿越被拒
- 新增/更新测试 + http e2e 覆盖以上全部

## 风险

- 中：发布路径写库语义变化，需兼容旧数据；媒体路由是新 HTTP 面，注意范围校验与 mime
- 决策点（开工前定）：enabled 方案更新校验失败时"拒绝"还是"自动转 draft"——本方案默认**拒绝**，更简单且不丢发布状态

## 验证方式

- `cd src && npm run check` 全绿
- 手动冒烟：admin 上传视频 → 发布 → 患者 browse video show 拿 URL → curl 该 URL 能下载
