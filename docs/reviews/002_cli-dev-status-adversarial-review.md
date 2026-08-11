# 002 Codex（gpt-5.6-sol）对抗评审结果 + 复核意见（2026-08-02）

> 评审对象：[`001_cli-dev-status-review.md`](001_cli-dev-status-review.md)（5 分身调研报告）
> 评审方式：codex CLI + gpt-5.6-sol，read-only 沙箱，独立抽查证据 ≥15 处、跑 96 条只读命令、两次上下文压缩。
> 本文档 = codex 判决摘要 + 本文作者（kimi）对每条判决的**独立复核**（认同/部分认同/不认同，附亲自核验的证据）。

## 一、codex 总判

> "这份报告不能直接作为'约 80% 完成、可进入收尾阶段'的决策依据。它把'命令已注册、适配器存在、测试覆盖到某条路径'多次等同于'设计验收已完成'。"
> codex 重判：患者 §17 = 9 通过/2 部分/4 失败（报告称 14/15）；管理 §15 = 7 通过/1 部分/7 失败（报告称 11/3/2，且 11+3+2=16 超过总项数 15）。

## 二、P0 判决与我的复核

### P0-1 §17 重判：报告"14/15 ✅"错误
- **codex**：真实失败 4 项（原记录 UI 不保留、健康档案入口、浏览与 RAG 独立、匿名不保存），部分 2 项（环境转暴露、内容有效性）。证据：index.html:136 导航禁用、conversation-service.ts:98 无知识端口、:112 匿名落库。
- **复核：部分认同**。我亲自核对 §17 原文（患者设计:970-984）后重判 = **11 ✅ / 2 延期（记录 UI、"我的"入口——交付协议明确属薄壳任务）/ 1 🚧（环境→暴露确认流）/ 1 ❌（匿名持久化）**。codex 的 9/2/4 把"经决策延期的薄壳条款"计入失败，且 item 8（无 RAG 则独立门禁无从违反）判 ❌ 偏严；但**方向正确：我的 14/15 确实过于乐观**。

### P0-2 患者 Agent 两套不等价状态机
- **codex**：裸 `agent start`（无 message）走旧 AgentService——只问一个急症问题然后固定 `clinical_content_unavailable` 死胡同；`agent continue` 强制 session ID（设计 6.5 要求裸 continue 续最近会话）；候选事实只有 proposed 无确认入口；ConversationService 无 RAG 端口。
- **复核：认同**。亲验 agent-service.ts:113-155（evaluate 一题三分支全部终局）、application.ts:344-356 分流注释、患者设计:216（`kangmin agent continue` 无 ID 契约）。我报告把"语义分流"当中性特性报，未指出旧外壳≠设计对话体验、continue 违反契约。**这是报告最实质的误判之一。**

### P0-3 匿名"24h 保留/不保存"名不副实
- **codex**：匿名会话首轮即落库（:112）、决策消息无条件保存、按 ID 可恢复；`findAnonymousSession` 只查 `patient_id IS NULL` 无时间条件（sqlite-conversation-repository.ts:100-107）；24h 期限无任何执行点。
- **复核：认同（重磅发现）**。亲验：retention_until 列存在、创建时写入 now+24h（conversation-service.ts:581-583），但全仓 grep **无任何查询过滤或清理任务引用它**。我报告"匿名一次性体验 ✅"错误；此条同时推翻 delivery-status.md 的 [x] 记录。

### P0-4 命令计数错误
- **codex**：COMMAND_SPECS 实际 64 条（content 30/agent 21/users 5/auth 8），不是 66/71；§15 我的数字 11+3+2=16 超总项。
- **复核：认同**。亲自数注册表 = **64 条**。我的 66/71、auth 9/9 均错。

### P0-5 方案浏览焊死 + 媒体交付链断裂
- **codex**：①browse 首页无环境聚合（browse-service.ts:15-34 只有文章/视频/分类——亲验属实）；②planBrowseEnabled 默认 false 且**组合根无注入口**（composition-root.ts:213 裸构造——亲验属实），永远返回成功空；③发布时 `media_url = stored_path`（服务器绝对路径，sqlite-content-admin-repository.ts:258-259——亲验属实），HTTP 无媒体路由 → 患者拿到**不可播放且泄露服务器目录结构**的路径。
- **复核：认同**。③是最严重的漏报——我报告只轻描淡写"对象存储后续接入"，没发现发布路径把本地绝对路径直接暴露给患者。

### P0-6 updatePlan 绕过启用校验
- **codex**：校验只在 enablePlan；updatePlan 保留 enabled 状态却允许清空必填内容/换未发布视频，不重跑完整校验。
- **复核：认同**。亲验 agent-admin-service.ts:508-557（仅 syndrome/video 存在性校验，状态 `...current` 保留）vs :559 启用路径完整校验。可构造"状态 enabled、内容已不安全"的方案。我的 D4 只发现一半。

### P0-7 "无成功空壳"论断有反例
- **codex**：环境测试桩由正常命令返回成功数据；方案浏览关闭时返回成功空列表。
- **复核：认同（带细微差别）**。composition-root.ts:73-79 默认 TestEnvironmentProvider 属实；payload 标 `test-double`、doctor 报 not_configured 属实——但**正常患者命令确实返回成功的假数据**，我"所有未实现都明确报错"的绝对化论断不成立。

### P0-8 "80%"无可复算口径
- **复核：认同方法论批评**。百分比是印象分，不应进里程碑判断。修正口径见第四节。

## 三、P1/P2 判决与我的复核（ condensed ）

| codex 判决 | 复核 |
|---|---|
| P1-1 管理端模型配置与患者运行时断开（患者硬编码 deepseek-chat+环境变量，composition-root.ts:197-199） | **认同**，亲验属实。管理端=孤立控制面 |
| P1-2 D1-D6 修正：D1 漏报 sessionCount/activity 语义错；D2 是角色契约违反非"加固"；D5 漏 --category 被忽略；D6 权重过高 | **认同**（D6 降权也接受，语义等价） |
| P1-3 账号凭据安全被低估（手机号验证→本地用户名密码、token 打印终端、凭据 JSON 文件非系统安全存储） | **认同**，我"CLI 形态合理偏离"定性过轻 |
| P1-4 同意机制未成处理前置（设计 5 类:690-698 实现 2 类；agent/record 无强制点；saveConsent 不绑账户同意） | **认同**，亲验设计原文，我漏报了"无强制点"这一半 |
| P1-5 方案患者端不投影风险/禁忌/注意事项/视频；危险方法靠自由文本含"灸/刮/拔罐"可绕 | **认同**，与 delivery-status 已知 MSAF 语义重叠记录互相印证 |
| P1-6 数据库 CHECK 仍允许 `review` 审批状态（database.ts:269） | **认同**（低危：代码层不可达，但持久层合同违设计） |
| P1-7 占位清单不完整（grep TODO 找不到行为型空壳） | **认同**，方法论批评成立 |
| P1-8 事务：新会话与首轮不原子、审计与主写非原子 | **认同**——但注明这两条是 delivery-status **已记录在案**的已知项，我报告未转述 |
| P2-1 0013 API Key 加密需限定环境（测试适配器只是 Base64） | **认同**，表述应限定 |
| P2-2 "180/180 全绿"无法独立复现（沙箱 EPERM 141 失败） | **不认同**。我的分身 4 在正常 shell 实跑 `npm run check` 全链路 exit 0、180/180、e2e PASS——该结论有真实运行支撑；codex 在禁写临时目录的沙箱里跑不了是环境产物，不能反推"未证实"。接受"报告应附命令输出"的文档批评 |
| P2-3 各组百分比缺口径 | **认同**，同 P0-8 |
| codex 证据质量两处小错：引 `src/kernel/clinical-rule-kernel.ts`（实际 `src/modules/clinical-rules/`）、`src/cli/errors.ts`（实际 `src/kernel/`） | 记录在案——对抗评审自身的证据也应准确 |

## 四、修正后的 CLI 完善度结论

弃用单一百分比，改分层口径（基线 HEAD `e74e369`）：

| 层 | 完善度 | 说明 |
|---|---|---|
| 骨架/基础设施（kernel、迁移账本、加密、幂等、审计、契约、退出码） | **≈90-95%** | 生产级，无隐藏 stub；180 测试+门禁+e2e 全绿（正常环境实跑证实） |
| 业务闭环（record CRUD、browse 文章/视频、content/plan/users/auth 管理） | **≈60-70%** | record 接近完整；browse 缺环境聚合/方案焊死/媒体交付断裂；管理端命令 64 条注册但有语义错误与校验绕过 |
| 智能化链路（RAG、模型配置贯通、test run、候选确认、consent 门禁） | **≈20-30%** | 患者模型真实但孤立；管理端模型测试 stub；无 RAG 端口；候选无确认入口 |

**一句话：骨架生产级，智能链路未通，内容交付有真 bug。**

## 五、修正后的差距清单（按严重度）

**P0（真实性/临床安全/数据泄露）**
1. 匿名会话：一次性体验名不副实（落库+按 ID 可恢复）+ 24h 保留期零执行点——要么真不落库，要么补保留期清理任务+查询过滤
2. 媒体交付链断裂：发布把服务器绝对路径写进 `media_url`，HTTP 无媒体路由——不可播放 + 目录结构泄露
3. `updatePlan` 绕过启用校验（enabled 方案可清空内容/换未发布视频）
4. 患者 Agent 双状态机分裂 + 旧外壳一题死胡同 + `agent continue` 强制 ID 违反设计契约
5. `planBrowseEnabled` 无注入口（方案永远成功空）+ browse 首页无环境聚合
6. 环境测试桩以成功数据返回（非 local 环境应拒绝或输出显著标记）

**P1（契约/安全/链路）**
7. 管理端模型配置与患者运行时断开 + `model test`/`test run` stub
8. 同意机制：2/5 类型、无强制点、`saveConsent` 不绑账户同意
9. 方案患者端不投影风险/禁忌/注意事项/视频；危险方法自由文本识别脆弱
10. 无 RAG/知识检索端口；候选事实无确认/修改/忽略入口
11. `users sessions/activity` 语义错误（登录会话当对话会话、库存当浏览量）；medication 投影恒 null
12. 普通管理员反而不能查看 users 数据（D2 角色契约反转）
13. 账号凭据：手机号验证→本地用户名密码、token 打印终端、凭据文件非系统安全存储
14. 事务：新会话与首轮不原子、审计与主写非原子（delivery-status 已记录在案）
15. DB 残留 `review` 状态；article import、knowledge preview/update、文章 --category 过滤缺失

**P2（文档/表述）**
16. 我的报告计数错误（66/71→实际 64；§15 判定数 16>15）；README 迁移 12→13
17. PlaintextEncryption=Base64 需限定环境表述；retention 占位常量未书面确认
18. consent 类型、环境失败码集合不全等设计小偏差
