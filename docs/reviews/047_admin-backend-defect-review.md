# 管理后台缺陷复查与 Issue 登记

## 状态

- 日期：2026-08-28
- 评审基线：`main@947e87a`；管理后台运行时代码未在本轮修改
- 范围：`src/apps/kangmin-admin`、管理 API/core；业务范围服从报价 truth 中的文章、视频、AI 知识库和站内消息
- 结论：P0 为 0，登记 5 条 P1 和 3 条 P2，共 8 条 GitHub Issue
- Issue：[#390](https://github.com/Bwkyd/kangmin-pioneer-ai-health/issues/390)、[#391](https://github.com/Bwkyd/kangmin-pioneer-ai-health/issues/391)、[#392](https://github.com/Bwkyd/kangmin-pioneer-ai-health/issues/392)、[#393](https://github.com/Bwkyd/kangmin-pioneer-ai-health/issues/393)、[#394](https://github.com/Bwkyd/kangmin-pioneer-ai-health/issues/394)、[#395](https://github.com/Bwkyd/kangmin-pioneer-ai-health/issues/395)、[#396](https://github.com/Bwkyd/kangmin-pioneer-ai-health/issues/396)、[#397](https://github.com/Bwkyd/kangmin-pioneer-ai-health/issues/397)

## 评审方法与证据

本轮使用 `km-review` 的患者可懂性、工程事实、医学安全三视角；只检查可复现或有明确代码路径的问题，不把风格偏好或未确认的产品选择登记为缺陷。通过隔离 integration SQLite、虚构管理员 `review-owner` 和 Chromium 进行后台路径复现，未使用真实患者数据、凭据或生产服务。

- 动态复现：已发布站内消息编辑后仍保持“已发布”（#390）；站内消息未保存表单离开导航后消失（#391）；知识库新增表单离开导航后消失（#392）；会话在数据库撤销后页面仍展示已缓存管理数据（#396）。
- 动态辅助证据：临时库的 `audit_events` 在消息新增、编辑、发布、再编辑流程中只有登录和发布事件，缺少新增/编辑事件（#394）。
- 静态代码复核：正文附件异步上传使用上传开始时捕获的旧正文（#393）；`/v1/admin/session` 未调用已有 strict 限流器（#395）；知识库单资料检索结果与全库复核共用且不清空，且界面不显示 `enabled` 状态（#397）。

## 问题清单

| 级别 | Issue | 影响摘要 | 证据 |
| --- | --- | --- | --- |
| P1 | [#390](https://github.com/Bwkyd/kangmin-pioneer-ai-health/issues/390) | 编辑已发布站内消息不会回退草稿，修改立即对患者可见 | 本地浏览器 + 服务端状态路径 |
| P1 | [#391](https://github.com/Bwkyd/kangmin-pioneer-ai-health/issues/391) | 站内消息未保存表单离开页面会静默丢稿 | 本地浏览器复现 |
| P2 | [#392](https://github.com/Bwkyd/kangmin-pioneer-ai-health/issues/392) | AI 知识库上传、换文件和修改信息的未保存输入会丢失 | 本地浏览器复现 + 代码路径 |
| P1 | [#393](https://github.com/Bwkyd/kangmin-pioneer-ai-health/issues/393) | 正文附件上传完成后可能用旧正文覆盖上传期间的编辑 | 异步闭包代码路径 |
| P1 | [#394](https://github.com/Bwkyd/kangmin-pioneer-ai-health/issues/394) | 内容新增与编辑没有审计事件，无法追溯操作 | 临时 SQLite 审计查询 + 服务代码 |
| P1 | [#395](https://github.com/Bwkyd/kangmin-pioneer-ai-health/issues/395) | 管理员登录接口未接入限流，可无限尝试口令 | 路由与限流代码路径 |
| P2 | [#396](https://github.com/Bwkyd/kangmin-pioneer-ai-health/issues/396) | 会话撤销或过期后页面仍展示已加载的管理数据 | 临时 SQLite 撤销 + 本地浏览器复现 |
| P2 | [#397](https://github.com/Bwkyd/kangmin-pioneer-ai-health/issues/397) | 全库检索复核会残留单资料测试命中，误导启用状态判断 | 检索状态代码路径 |

每条 Issue 均包含复现步骤、代码位置、预期行为和验收条件，并已逐条通过 `gh issue list` 回读确认状态为 `OPEN`。Issue 登记不等于修复完成、客户验收或生产就绪。

## 三视角结论与边界

### 患者可懂性

已发布内容编辑后立即可见、消息和知识输入静默丢失、过期会话仍能看到旧页面，分别会造成内容误发布、运营人员误以为已保存以及权限状态与界面不一致。问题描述和验收条件优先要求状态真实、失败可见、输入可恢复。

### 工程事实

文章/视频编辑已有“已发布 → 草稿”的状态回退路径，站内消息更新路径没有同等处理；内容编辑页已有草稿恢复机制，消息和知识管理弹窗没有对应保护；已有审计表和 strict 限流配置，但新增/编辑写入及管理员登录路由没有接入；会话首次检查失败时没有清空已加载数据；知识检索测试状态没有与全库复核隔离。

### 医学安全

本轮没有发现新的 P0 医学规则或患者输出缺陷，也没有修改问卷、证型、期别、调理方案、禁忌或知识 truth。修复时仍须保持：管理后台只维护已确认内容；发布状态、知识启用状态和权限状态 fail-closed；审计记录不写入患者正文、密钥或其他敏感数据；不以模型判断替代确定性发布和安全规则。

## 验证与限制

- `bash scripts/check-tools.sh`：通过。
- `cd src && npm run check`：退出 0；Node 测试 442 条，364 通过、78 条因本机未配置 PostgreSQL/S3 跳过、0 失败；管理端测试 2/2 通过；真实 Chromium `web-browser-e2e` 通过。
- `python3 scripts/check-manifests.py` 和 `git diff --check`：通过；`python3 scripts/structure-lint.py .` 仅报告任务前已存在的两个 `_work/` 中文目录名（`20260814-福建省中医药适宜技术手册-md`、`20260821-微信文章-md`），本轮未修改。
- 动态复现使用隔离数据库、虚构管理员和本地构建产物；#393、#395、#397 的结论来自当前代码路径，修复后需要补回归测试和真实适配器验证。
- 本轮只新增评审、状态和 GitHub Issue；未修改 `src/`、truth、数据库 schema、生产服务或 `hi.md`。现有 PostgreSQL/S3 跳过项不扩大解释为完整生产验收。
