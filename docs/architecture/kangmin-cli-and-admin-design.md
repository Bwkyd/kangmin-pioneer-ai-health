# 抗敏先锋患者 CLI 与管理员后台设计

- 状态：待确认
- 日期：2026-07-30
- 关联 Issue：#69、#70、#71、#88～#99、#101、#123
- 设计范围：命令与应用边界，不包含实现

## 1. 结论

抗敏先锋提供两个彼此隔离的产品入口：

```text
患者入口
├── kangmin CLI
└── 患者 H5 前端

管理员入口
├── kangmin-admin CLI
└── 管理后台 Web 前端
```

患者 CLI 从患者真实任务出发，不暴露后台资源管理命令：

```text
1. kangmin                 主命令：启动鼻健康 Agent
2. kangmin health          健康记录与环境信息
3. kangmin learn           浏览已发布文章和视频
4. kangmin auth / help     登录、账户和辅助
```

管理员后台使用独立入口 `kangmin-admin`。后台只有一种 `admin` 角色，可以分配给多个普通管理员。所有管理员拥有相同后台功能，不再拆分内容管理员、知识管理员或临床审核员角色。

管理员可以查看简化的产品用户数据，包括用户账号、最近活跃时间、会话记录和患者提交的健康记录；查看行为需要审计，管理员不能冒充患者，也不能直接修改患者健康事实。

## 2. 设计依据

42md CLI 把最高频客户任务放在最短入口：

```text
42md <文件或 URL>    主任务
42md tools           客户工具
42md kb              客户知识库
42md auth / help     辅助能力
```

其公开 CLI 从真实客户任务出发，而不是公开内部管理后台的资源结构。CLI 与 Web 使用同一账号和云端数据，但管理控制面不会取代客户主入口：

- [42md CLI](https://42md.cc/cli)
- [42md CLI 命令参考](https://42md.cc/docs/cli-commands)

抗敏先锋采用相同原则：

1. `kangmin` 直接启动 Agent，不要求患者记忆 `agent run`。
2. 患者常用动作按 `health` 和 `learn` 组织。
3. 登录和帮助属于低频辅助能力。
4. 管理后台真实存在，但通过独立的 `kangmin-admin` 和管理 Web 入口提供。

## 3. 目标与非目标

### 3.1 目标

- 患者输入 `kangmin` 即进入 Agent 对话。
- Agent、患者记录和浏览内容形成完整患者闭环。
- 管理员能管理文章、视频、Agent 知识库和临床候选。
- 管理员能查看简化的产品用户、会话和健康记录数据。
- CLI 与前端调用同一应用服务，前端不复制业务规则。
- 机器调用有稳定 JSON、退出码、幂等和版本控制。
- 未批准临床内容不能进入 Agent、RAG 或患者端。

### 3.2 非目标

- 本文不实现 CLI、登录、数据库、Agent 或前端。
- 不恢复已关闭 Issue 中未被当前开放需求引用的功能。
- 不自行批准 #88～#99 的临床候选内容。
- 不接入 #101 尚未确认的真实花粉数据源。
- 不把管理员后台命令展示为患者 CLI 的主要能力。
- 一期不提供复杂组织、岗位或细粒度管理员角色系统。

## 4. 身份、账号与角色

### 4.1 两个身份域

患者与管理员使用相同的认证技术，但属于两个独立身份域：

| 身份域 | 入口 | 会话用途 |
| --- | --- | --- |
| 患者 | `kangmin auth login`、患者 H5 | Agent 对话、个人记录、内容浏览 |
| 管理员 | `kangmin-admin auth login`、管理后台 | 内容、知识、临床候选、用户和审计管理 |

两个身份域使用不同的服务端会话和客户端凭据存储键。患者会话不能调用管理 API，管理员会话也不能被当成患者身份读取或写入个人健康记录。

### 4.2 患者账号

- H5 一期使用已验证手机号建立服务端身份。
- 内部使用供应商无关的 `userId`。
- 未登录用户可以完成一次性评估，但默认不保存跨设备历史。
- 保存对话、健康记录、历史查询、导出或删除数据前必须登录。
- CLI 登录凭据保存到 macOS Keychain 等系统安全存储，不写入仓库、普通配置文件或命令历史。

### 4.3 管理员账号

后台只有一种角色：

```text
admin
```

可以创建多个独立管理员账号，每个管理员都具备相同功能：

- 内容管理；
- Agent 知识库管理；
- 临床候选登记和审批状态管理；
- 产品用户数据查看；
- 管理员账号分配；
- 审计查看。

管理员账号管理要求：

- 只有已登录管理员可以新增或停用其他管理员。
- 不能停用最后一个有效管理员。
- 新管理员必须使用独立账号，禁止多人共用同一凭据。
- 管理员的新增、停用、登录和敏感数据查看均进入审计日志。
- CLI 参数不能通过 `--role admin` 自行提升权限。

### 4.4 临床批准含义

取消独立“临床审核员”角色不代表管理员可以自行创造临床结论。

管理员可以在系统中记录客户或临床负责人的书面确认，并将候选状态更新为已批准。批准记录至少包含：

- 候选内容版本；
- 书面确认依据或引用；
- 实际确认人姓名或标识；
- 录入该确认的管理员；
- 确认日期和录入日期；
- 与上一版本的差异。

缺少书面确认依据时，管理员不能把临床候选发布为正式规则。

## 5. 患者 CLI

### 5.1 Agent 主入口

```bash
kangmin
```

启动交互式鼻健康 Agent。

```bash
kangmin "我最近鼻塞，而且有点发烧"
```

带首条消息启动交互会话。

```bash
kangmin --continue
kangmin --resume <session-id>
```

继续当前患者最近会话或恢复指定会话。

```bash
kangmin exec "总结我的最近记录" --output-format json
```

执行一次非交互 Agent 任务，供自动化、测试和其他 AI 调用。

Agent 固定执行顺序：

```text
用户输入
→ 模型提取待确认候选
→ 用户确认
→ 固定安全规则
→ 固定适用条件、严重度和证型规则
→ 查询已批准方案
→ 检索已批准且已发布知识
→ 模型解释结构化结果
→ 保存决策凭证（已登录时）
```

Agent 不能：

- 自行决定或修改证型规则；
- 自行新增穴位、疗程、力度、剂量或疗效；
- 读取草稿、待审核或已下架知识；
- 调用管理员写操作；
- 把 `unknown` 当成安全；
- 在没有正式方案时根据模型常识补齐方案。

### 5.2 未登录行为

未登录运行 `kangmin` 时：

1. 显示医疗边界和隐私提示；
2. 允许一次性评估；
3. 在需要保存会话或记录前引导 `kangmin auth login`；
4. 登录成功后由用户明确确认是否保存本次会话；
5. 用户拒绝登录时，本次会话结束后不形成跨设备历史。

`--help`、`--version`、`doctor` 和公开的 `learn` 内容不要求登录。

### 5.3 `health`

当前开放需求只纳入过敏原暴露和花粉环境信息：

```text
kangmin health status
kangmin health exposure record
kangmin health exposure list
kangmin health exposure show <id>
kangmin health exposure update <id>
kangmin health pollen
```

示例：

```bash
kangmin health exposure record \
  --date 2026-07-30 \
  --environment dust,pollen \
  --json
```

约束：

- 暴露记录是患者自述事实，不直接等于医学确认的过敏原。
- “未识别明确因素”与具体因素互斥。
- 创建需要幂等键，更新需要当前版本。
- 患者只能访问自己的记录。
- 花粉数据源未确认前返回 `provider_unconfigured`，不得生成模拟指数冒充真实数据。

### 5.4 `learn`

```text
kangmin learn list
kangmin learn categories
kangmin learn search <query>
kangmin learn article <id>
kangmin learn video <id>
```

`learn` 只读取：

- 已审核；
- 已发布；
- 当前版本有效；
- 关联媒体有效；
- 面向患者可见；
- 保留医疗免责声明。

草稿、待审核、处理失败、已下架内容及其媒体直链都不可读取。

### 5.5 `auth` 与辅助

```text
kangmin auth login
kangmin auth status
kangmin auth whoami
kangmin auth logout

kangmin --help
kangmin help
kangmin doctor
kangmin --version
kangmin completion zsh
```

`auth status --json` 至少返回：

```json
{
  "authenticated": true,
  "userId": "usr_123",
  "identityDomain": "patient",
  "sessionExpiresAt": "2026-08-06T12:00:00Z"
}
```

不得输出手机号、访问令牌或完整健康信息。

## 6. 管理员 CLI

### 6.1 默认入口

```bash
kangmin-admin
```

启动管理 TUI。未登录时引导管理员登录；非管理员账号不能进入。

```text
kangmin-admin auth login|status|logout
kangmin-admin dashboard
kangmin-admin users
kangmin-admin content
kangmin-admin knowledge
kangmin-admin clinical
kangmin-admin admins
kangmin-admin audit
```

管理员 CLI 不出现在患者 CLI 的四类主帮助中，单独提供管理员文档和自动补全。

### 6.2 管理员仪表盘

```bash
kangmin-admin dashboard --json
```

一期只显示简单统计：

- 产品用户总数；
- 最近 7 天和 30 天新增用户数；
- 最近 7 天活跃用户数；
- Agent 会话总数和最近 7 天会话数；
- 健康记录总数；
- 已发布文章数；
- 已发布视频数；
- 待处理知识来源数；
- 待确认临床候选数。

统计数据不能包含患者完整健康文本。

### 6.3 产品用户数据

```text
kangmin-admin users list
kangmin-admin users show <user-id>
kangmin-admin users sessions <user-id>
kangmin-admin users records <user-id>
```

用户列表默认展示：

| 字段 | 说明 |
| --- | --- |
| `userId` | 内部用户 ID |
| `phoneMasked` | 脱敏手机号 |
| `status` | active / disabled |
| `createdAt` | 注册时间 |
| `lastActiveAt` | 最近活跃时间 |
| `sessionCount` | Agent 会话数量 |
| `recordCount` | 健康记录数量 |

用户详情可以只读查看：

- 完整手机号（需要显式展开并记录审计）；
- 注册与登录状态；
- 最近 Agent 会话列表；
- 指定会话的患者消息和 Agent 回复；
- 患者提交的过敏原暴露记录；
- 当前范围内其他已确认需要保存的健康记录。

一期明确不提供：

- 管理员冒充患者登录；
- 管理员替患者修改健康事实；
- 管理员停用、删除或修改患者账号；
- 全量患者数据批量导出；
- 将生产患者数据复制到测试环境；
- 无审计读取完整手机号或会话正文；
- 在列表页面直接展示完整健康文本。

管理员查看用户详情、完整手机号、会话正文或健康记录时，审计日志记录管理员、用户、时间、访问类型和用途备注。

### 6.4 文章与视频

```text
kangmin-admin content article list|show|create|update
kangmin-admin content article import|preview|publish|unpublish

kangmin-admin content video list|show|create|update
kangmin-admin content video preview|publish|unpublish
```

内容状态：

```text
draft
→ processing
→ preview_ready
→ published
→ unpublished

processing → failed
```

一期只有一种管理员角色，因此不增加独立内容审核岗位。发布操作仍需：

- 当前内容版本；
- 必填字段和媒体校验；
- 对临床操作内容执行临床确认门禁；
- 显式 `--yes`；
- 幂等键；
- 审计记录。

### 6.5 Agent 知识库

```text
kangmin-admin knowledge source list|show|add|update
kangmin-admin knowledge source preview
kangmin-admin knowledge source approve
kangmin-admin knowledge source index
kangmin-admin knowledge source publish
kangmin-admin knowledge source unpublish
kangmin-admin knowledge search-test
```

知识状态：

```text
draft
→ processing
→ preview_ready
→ approved
→ indexed
→ published
→ retired
```

文章、视频与 Agent 知识来源是不同发布目标：

```text
后台素材
├── 发布到患者 learn
├── 发布到 Agent knowledge
├── 分别通过门禁后发布到两边
└── 只保留为后台草稿
```

约束：

- 上传完成不等于批准；
- 批准不等于索引完成；
- 索引完成不等于发布；
- Agent 只检索 `approved + indexed + published` 的当前版本；
- 新版本索引失败时，旧的有效版本继续服务；
- 视频进入知识库前需要经过审核的文字稿；
- 知识文本只能作为检索资料，不能作为系统指令执行。

### 6.6 临床候选

```text
kangmin-admin clinical candidate list|show|register|diff
kangmin-admin clinical approval record
kangmin-admin clinical release-check
kangmin-admin clinical publish
kangmin-admin clinical unpublish
```

承接 #71、#88～#99：

- 鼻三线姜刮；
- 普通刮痧；
- 耳穴压豆；
- 艾灸；
- 电吹风；
- 拔罐；
- 放血；
- 儿童方案；
- 五种证型方案映射；
- 每种方法独立安全规则。

管理员只能根据已获得的书面确认记录批准状态。没有书面确认、来源、版本或差异时，`release-check` 必须失败。

### 6.7 管理员分配

```text
kangmin-admin admins list
kangmin-admin admins add
kangmin-admin admins disable <admin-id> --yes
kangmin-admin admins enable <admin-id> --yes
```

管理员列表包含：

- 管理员 ID；
- 登录标识；
- 状态；
- 创建时间；
- 最近登录时间；
- 创建该账号的管理员。

所有管理员权限相同。系统必须阻止：

- 停用最后一个有效管理员；
- 管理员修改自己的审计历史；
- 重复账号创建；
- 未确认的并发覆盖。

## 7. 前端壳

### 7.1 患者 H5

患者登录后可以：

- 与 Agent 对话；
- 浏览 `learn` 文章和视频；
- 记录并查看自己的 `health` 数据；
- 恢复自己的历史会话。

患者 H5 与 `kangmin` 使用相同的患者应用服务。

### 7.2 管理后台 Web

管理员登录后进入独立管理页面：

```text
仪表盘
├── 用户数据
├── 文章
├── 视频
├── Agent 知识库
├── 临床候选
├── 管理员账号
└── 审计
```

管理后台与 `kangmin-admin` 使用相同的管理应用服务。

前端只负责：

- 表单和数据展示；
- 调用应用服务；
- 显示确认、阻塞和错误状态；
- 根据服务端授权结果展示入口。

前端隐藏按钮不能代替服务端权限校验。

## 8. 应用边界

```text
kangmin CLI ────────┐
患者 H5 ────────────┼── Patient Application Services
                    │   ├── Agent Runtime
                    │   ├── Health Records
                    │   └── Published Content
                    │
kangmin-admin CLI ──┐
管理后台 Web ───────┼── Admin Application Services
                        ├── User Read Model
                        ├── Content Management
                        ├── Knowledge Management
                        ├── Clinical Governance
                        ├── Admin Accounts
                        └── Audit
```

共享领域能力：

- 固定临床规则；
- 内容和知识版本；
- 身份映射；
- 数据存储端口；
- 审计事件格式。

禁止：

- 患者应用服务导入管理员命令处理器；
- 管理员服务绕过患者数据归属查询；
- 前端直接读取数据库；
- 新 `src/` 直接导入 `legacy/` 业务状态或框架模块。

## 9. CLI 通用契约

### 9.1 JSON

```json
{
  "ok": true,
  "command": "health exposure record",
  "status": "completed",
  "data": {},
  "meta": {
    "schemaVersion": "1",
    "requestId": "req_123"
  }
}
```

`--json` 模式下：

- stdout 只输出机器数据；
- 进度和诊断进入 stderr；
- 非交互环境不能停在确认提示；
- 付费、发布、停用等高影响操作需要显式 `--yes`。

### 9.2 退出码

| 退出码 | 含义 |
| --- | --- |
| `0` | 成功 |
| `2` | 命令或参数错误 |
| `3` | 资源不存在 |
| `4` | 状态或版本冲突 |
| `5` | 临床确认缺失 |
| `6` | 外部数据或配置缺失 |
| `7` | 输入校验失败 |
| `8` | 安全规则阻断 |
| `9` | 未登录或权限不足 |
| `10` | 批量操作部分失败 |

### 9.3 写操作

所有写操作要求：

- 服务端身份；
- 幂等键；
- 更新时提供当前版本；
- 返回新版本和审计事件 ID；
- 查询/预览与发布/停用分开；
- 不静默降级到其他模型、规则或数据源。

## 10. 数据与安全

- D1 保存结构化用户、记录、内容版本、知识元数据和审计。
- R2 保存图片、视频、导入文件和知识源文件。
- 生产患者数据不得复制到 local、integration 或未经批准的 staging。
- 患者和管理员 API 使用不同会话命名空间和授权中间件。
- 管理员查看敏感用户详情要审计，默认列表使用脱敏信息。
- 日志不得记录访问令牌、完整手机号或无必要的健康正文。
- Agent 会话正文不进入普通调试日志。
- 用户停用不等于立即物理删除；删除和保留期限另行确认。
- 管理员账号停用后，所有现有管理会话立即失效。

## 11. 当前开放 Issue 映射

| Issue | 患者入口 | 管理员入口 | 当前状态 |
| --- | --- | --- | --- |
| #69 | `health exposure`、`learn` | `content` | 聚合需求 |
| #70 | `learn` | `content article/video`、`knowledge` | 聚合需求 |
| #71 | `kangmin` | `clinical` | 聚合临床需求 |
| #88～#98 | Agent 仅消费已批准结果 | `clinical candidate` | 等待临床确认 |
| #99 | 未批准内容不可见 | `knowledge`、`clinical release-check` | 发布门禁 |
| #101 | `health pollen` | 后续数据源配置 | 等待外部确认 |

Issue #123 只承载本文档，不属于产品功能。

## 12. 验证标准

设计进入实现前必须满足：

- 患者输入 `kangmin` 可以直接理解为启动 Agent。
- 患者公开帮助只强调 Agent、health、learn、auth/help 四类。
- 管理员命令不进入患者主帮助和患者 Agent 工具集。
- 患者与管理员身份域、会话和 API 权限相互隔离。
- 可以分配多个同权限管理员，且不能停用最后一个管理员。
- 管理员可以查看简化用户列表、会话和健康记录，但不能冒充或修改患者事实。
- 文章/视频患者发布与 Agent 知识发布是两个独立目标。
- 临床候选缺少书面确认时无法发布。
- 所有敏感查看和后台写操作可审计。
- CLI 与两个前端壳复用应用服务，不复制业务规则。
- #101 未确认前不会展示伪造花粉数据。

## 13. 后续实现顺序

本文确认后再进入实现：

1. 患者/管理员身份域和会话契约；
2. `kangmin` 交互与非交互会话骨架；
3. `health` 和 `learn` 患者命令；
4. `kangmin-admin` 用户只读视图和管理员账号；
5. 文章与视频管理；
6. Agent 知识库生命周期；
7. 临床候选和发布门禁；
8. 患者 H5 与管理后台薄壳。

临床候选和真实花粉数据仍受外部确认阻塞。
