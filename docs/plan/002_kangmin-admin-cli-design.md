# 002 抗敏先锋管理后台 CLI 设计

- 状态：四组命令结构已确认，命令细节待实现
- 日期：2026-07-31
- 产品入口：`kangmin-admin` CLI 与管理后台 Web
- 设计范围：管理后台命令、应用服务、数据归属和 Web 映射
- 不包含：患者端命令、后台可编辑规则引擎、多人审核流和复杂角色系统

## 1. 结论

管理后台统一归为四组：

```text
1. content       内容运营
2. agent         智能体管理
3. users         用户数据
4. auth / help   登录与辅助
```

对应 CLI：

```bash
kangmin-admin content ...
kangmin-admin agent ...
kangmin-admin users ...
kangmin-admin auth ...
```

直接运行：

```bash
kangmin-admin
```

启动管理 TUI 或显示默认工作台。工作台只是四组数据的聚合首页，不构成第五组命令。

管理后台 Web 和 `kangmin-admin` 调用同一组管理应用服务。Web 不是在浏览器中执行 Shell，而是把相同命令契约呈现为表格、表单、预览和设置页面。

```text
kangmin-admin CLI ─┐
                   ├── Admin Application Services
管理后台 Web ──────┘
```

## 2. 设计原则

### 2.1 按管理员真实任务分组

```text
患者直接浏览的内容
→ content

Agent 回答时使用的知识、方案和模型
→ agent

患者用户、会话和健康记录的只读查询
→ users

管理员登录、账号和命令辅助
→ auth / help
```

### 2.2 不建设多人审核流程

客户管理员直接管理自己的文章、知识和调理方案。

系统流程是：

```text
编辑
→ 程序校验
→ 预览或测试
→ 管理员启用/发布
```

不设计：

```text
提交审核
→ 审核员审核
→ 主管批准
→ 正式发布
```

后台不出现：

- 待审核；
- 审核通过；
- 审核驳回；
- 临床审核员；
- 审批中心；
- 多级审批；
- 独立审计中心。

### 2.3 规则引擎由开发方维护

服务端固定规则引擎负责：

- 安全风险拦截；
- 适用条件；
- 严重程度；
- 证型判断；
- 动态补问；
- `unknown`；
- 信息不足；
- 答案冲突；
- 无匹配结果。

客户管理后台不能：

- 创建或修改证型；
- 修改辨证条件；
- 修改安全规则；
- 修改严重程度规则；
- 修改证型优先级；
- 把 `unknown` 改成安全；
- 通过模型提示词绕过规则引擎。

规则变更通过代码、测试、CI 和发布完成，不通过管理后台配置。

### 2.4 客户管理知识和调理方案

客户管理员负责：

- 上传和启用知识；
- 从固定证型列表选择适用证型；
- 配置证型对应调理方案；
- 配置方法、步骤、注意事项、风险和禁忌；
- 关联患者可用视频；
- 配置模型基本参数；
- 模拟测试 Agent 最终输出。

AI 只提取患者表达并解释结果，不能生成新的证型或补写不存在的调理方案。

### 2.5 只保留内部轻量修改编号

系统内部可以保存 `revision`，用于：

- 防止两个页面同时编辑时互相覆盖；
- 记录某次 Agent 输出使用的方案和知识状态；
- 发生错误时定位修改前后的内容。

`revision` 不是审核状态，也不形成管理员版本流程。Web 默认只需要显示：

```text
最后更新时间
最后更新人
当前是否启用
```

## 3. 顶层命令

```text
kangmin-admin
├── content
│   ├── article
│   ├── video
│   ├── media
│   ├── category
│   └── message
├── agent
│   ├── status
│   ├── knowledge
│   ├── plan
│   ├── model
│   └── test
├── users
│   ├── list
│   ├── show
│   ├── sessions
│   ├── records
│   └── activity
├── auth
│   ├── login
│   ├── status
│   ├── whoami
│   ├── admins
│   └── logout
├── help
├── doctor
├── completion
└── --version
```

公开帮助只强调四组：

```text
content      管理文章、视频、素材和公告
agent        管理知识库、调理方案、模型和模拟测试
users        只读查看患者用户、会话和健康记录
auth         登录并管理普通管理员账号
```

`help`、`doctor`、`completion` 和 `--version` 是全局辅助命令，不构成第五组业务能力。

## 4. `content`：内容运营

### 4.1 定义

`content` 管理患者不经过 Agent 就能在小程序“浏览”中直接看到的内容。

它拥有：

- 科普文章；
- 视频内容；
- 图片、视频和文档素材；
- 内容分类；
- 站内公告；
- 患者端发布状态。

它不拥有：

- Agent 知识索引；
- 证型判断；
- 调理方案匹配；
- 患者健康记录；
- 管理员账号。

### 4.2 命令树

```text
kangmin-admin content
├── article
│   ├── list
│   ├── show <id>
│   ├── create
│   ├── import <file>
│   ├── update <id>
│   ├── preview <id>
│   ├── publish <id>
│   └── unpublish <id>
├── video
│   ├── list
│   ├── show <id>
│   ├── create
│   ├── update <id>
│   ├── preview <id>
│   ├── publish <id>
│   └── unpublish <id>
├── media
│   ├── list
│   ├── show <id>
│   ├── upload <file>
│   ├── disable <id>
│   └── delete <id>
├── category
│   ├── list
│   ├── create
│   ├── update <id>
│   └── disable <id>
└── message
    ├── list
    ├── create
    ├── update <id>
    ├── publish <id>
    └── unpublish <id>
```

### 4.3 科普文章

查询：

```bash
kangmin-admin content article list
kangmin-admin content article list --status draft
kangmin-admin content article list --category 日常防护
kangmin-admin content article show <article-id>
```

创建：

```bash
kangmin-admin content article create \
  --title "换季鼻敏感注意事项" \
  --category "日常防护"
```

导入：

```bash
kangmin-admin content article import <article.docx>
kangmin-admin content article import <article.pdf>
```

导入流程：

```text
选择文件
→ 解析正文
→ 展示预览
→ 管理员确认
→ 保存为草稿
```

导入失败不能清空已有正文或图片。

编辑：

```bash
kangmin-admin content article update <article-id>
```

可修改：

- 标题；
- 摘要；
- 正文；
- 分类；
- 来源；
- 封面和正文图片；
- 展示顺序；
- 患者端免责声明。

预览：

```bash
kangmin-admin content article preview <article-id>
```

预览显示患者小程序的实际效果，但不对患者公开。

发布和下架：

```bash
kangmin-admin content article publish <article-id> --yes
kangmin-admin content article unpublish <article-id> --yes
```

发布前只做程序校验：

- 标题不能为空；
- 正文不能为空；
- 分类有效；
- 图片可用；
- 来源字段满足当前要求；
- 不引用已停用媒体。

不要求另一个管理员审核。

### 4.4 视频内容

查询和创建：

```bash
kangmin-admin content video list
kangmin-admin content video show <video-id>
kangmin-admin content video create
kangmin-admin content video update <video-id>
```

视频可以配置：

- 标题；
- 简介；
- 分类；
- 方法标签；
- 封面；
- 视频文件；
- 操作说明；
- 注意事项；
- 患者端免责声明。

预览和发布：

```bash
kangmin-admin content video preview <video-id>
kangmin-admin content video publish <video-id> --yes
kangmin-admin content video unpublish <video-id> --yes
```

发布前检查：

- 视频文件存在；
- 媒体处理完成；
- 标题和简介完整；
- 封面有效；
- 不引用已停用素材。

视频下架后：

- 患者浏览列表不可见；
- 原媒体直链不可继续访问；
- 依赖该视频的 Agent 方案不能继续以完整方案启用。

### 4.5 素材库

查询和上传：

```bash
kangmin-admin content media list
kangmin-admin content media show <media-id>
kangmin-admin content media upload <file>
```

支持：

- 图片；
- 视频；
- Word；
- PDF；
- Markdown；
- 知识源文件。

素材详情显示：

- 文件名；
- 类型；
- 大小；
- 处理状态；
- 是否可用；
- 被哪些文章、视频、知识或方案引用。

停用和删除：

```bash
kangmin-admin content media disable <media-id> --yes
kangmin-admin content media delete <media-id> --yes
```

仍被已发布文章、已启用知识或已启用方案引用的素材不能直接删除。

### 4.6 内容分类

```bash
kangmin-admin content category list
kangmin-admin content category create
kangmin-admin content category update <category-id>
kangmin-admin content category disable <category-id> --yes
```

分类用于：

- 文章分类；
- 视频分类；
- 推荐栏目；
- 展示顺序。

停用分类不删除历史内容，只是不再允许新内容选择。

### 4.7 站内公告

```bash
kangmin-admin content message list
kangmin-admin content message create
kangmin-admin content message update <message-id>
kangmin-admin content message publish <message-id> --yes
kangmin-admin content message unpublish <message-id> --yes
```

用于：

- 服务公告；
- 内容更新通知；
- 使用说明；
- 维护提示。

一期不自动扩展短信、邮件或微信订阅消息。

### 4.8 内容状态

统一使用简单状态：

```text
draft          草稿
processing     处理中
ready          可使用
published      已发布
unpublished    已下架
failed         处理失败
```

不使用审批状态：

```text
pending_review
approved
rejected
```

## 5. `agent`：智能体管理

### 5.1 定义

`agent` 管理 Agent 解释和输出调理方案时使用的：

- 知识库；
- 证型对应调理方案；
- 关联视频；
- 模型基本设置；
- 模拟测试。

固定规则引擎不属于客户可编辑命令。

### 5.2 正式运行链路

```text
患者对话
→ AI 提取待确认信息
→ 患者确认
→ 服务端固定规则引擎
→ 输出证型
→ 查询客户启用的证型调理方案
→ 查询关联视频
→ 检索已启用知识
→ AI 解释规则和方案结果
→ 输出调理方案及视频
```

约束：

- AI 不决定证型；
- AI 不修改安全规则；
- AI 不新增调理方法；
- AI 不补写客户未配置的方案；
- AI 不新增穴位、步骤、力度、疗程或剂量；
- 使用“调理方案”，不使用“治疗方案”或“确诊”。

### 5.3 命令树

```text
kangmin-admin agent
├── status
├── knowledge
│   ├── list
│   ├── show <id>
│   ├── add <file>
│   ├── update <id>
│   ├── preview <id>
│   ├── index <id>
│   ├── enable <id>
│   ├── disable <id>
│   └── search-test <query>
├── plan
│   ├── list
│   ├── show <id>
│   ├── create
│   ├── update <id>
│   ├── preview <id>
│   ├── enable <id>
│   ├── disable <id>
│   └── mappings
├── model
│   ├── show
│   ├── update
│   └── test
└── test
    ├── run
    └── case <case-id>
```

### 5.4 Agent 状态

```bash
kangmin-admin agent status
```

返回：

- 当前模型；
- 模型连接状态；
- 已启用知识数量；
- 索引失败数量；
- 已启用方案数量；
- 尚未配置方案的固定证型；
- 最近一次模拟测试状态。

不显示或修改规则引擎条件。

### 5.5 知识库

查询：

```bash
kangmin-admin agent knowledge list
kangmin-admin agent knowledge list --status enabled
kangmin-admin agent knowledge show <knowledge-id>
```

添加：

```bash
kangmin-admin agent knowledge add <knowledge.pdf>
kangmin-admin agent knowledge add <knowledge.docx>
kangmin-admin agent knowledge add <knowledge.md>
```

保存：

- 知识名称；
- 来源；
- 说明；
- 原始文件引用；
- 当前处理状态；
- 是否允许 Agent 检索。

预览：

```bash
kangmin-admin agent knowledge preview <knowledge-id>
```

检查：

- 是否正确解析；
- 是否乱码；
- 标题和正文是否完整；
- 来源是否正确；
- 内容分块是否合理。

索引：

```bash
kangmin-admin agent knowledge index <knowledge-id>
```

上传完成不等于索引完成。索引失败返回：

```text
index_failed
```

启用和停用：

```bash
kangmin-admin agent knowledge enable <knowledge-id> --yes
kangmin-admin agent knowledge disable <knowledge-id> --yes
```

含义：

- `enable`：Agent 可以检索；
- `disable`：Agent 停止检索。

检索测试：

```bash
kangmin-admin agent knowledge search-test "换季鼻塞"
```

返回：

- 命中文档；
- 命中片段；
- 来源；
- 当前启用状态；
- Agent 可以使用的引用信息。

知识库只帮助 AI 解释，不能改变规则引擎输出。

### 5.6 调理方案

查询：

```bash
kangmin-admin agent plan list
kangmin-admin agent plan list --status enabled
kangmin-admin agent plan show <plan-id>
```

创建和编辑：

```bash
kangmin-admin agent plan create
kangmin-admin agent plan update <plan-id>
```

客户配置：

- 方案名称；
- 适用证型；
- 调理方法；
- 操作步骤；
- 注意事项；
- 风险提示；
- 禁忌；
- 适用年龄；
- 关联视频；
- 展示顺序。

客户只能从服务端固定规则引擎提供的证型列表中选择，不能创建新证型或修改证型判断条件。

方案映射：

```bash
kangmin-admin agent plan mappings
```

示例：

```text
肺气虚寒
→ plan_001

脾气虚弱
→ plan_002

寒热错杂
→ plan_003
```

可以明确配置：

```text
当前证型暂无可用方案
```

预览：

```bash
kangmin-admin agent plan preview <plan-id>
```

显示：

- Agent 会读取的方案字段；
- 患者看到的步骤；
- 关联视频；
- 风险和禁忌；
- 缺失字段；
- 当前能否启用。

启用：

```bash
kangmin-admin agent plan enable <plan-id> --yes
```

启用前只做程序校验：

- 适用证型存在；
- 调理方法完整；
- 至少存在一个有效步骤；
- 必填风险和禁忌完整；
- 关联视频可用并允许患者访问；
- 不引用已停用资源。

不需要另一个人审核。

停用：

```bash
kangmin-admin agent plan disable <plan-id> --yes
```

停用后：

- 新 Agent 会话不能再匹配；
- 历史会话仍保留当时使用的方案摘要；
- 不自动修改患者已经收到的历史结果。

如果规则引擎输出证型，但没有启用方案，Agent 固定返回：

```text
当前结果已完成，但尚未配置对应的可用调理方案。
```

不能让 AI 自行补齐。

### 5.7 模型设置

查看：

```bash
kangmin-admin agent model show
```

显示：

- 模型提供方；
- 模型名称；
- 超时；
- 最大输出；
- 是否启用知识检索；
- 检索数量；
- 最近测试状态。

不显示完整 API Key。

修改：

```bash
kangmin-admin agent model update
```

允许配置：

- 模型提供方；
- 模型名称；
- 超时；
- 最大输出；
- 检索数量；
- 解释开关。

不允许配置：

- 证型规则；
- 安全判断；
- 严重程度；
- 动态补问逻辑；
- 调理方案内容；
- 穴位和禁忌。

测试：

```bash
kangmin-admin agent model test
```

验证：

- 模型连接；
- 候选提取；
- JSON 响应；
- 自然语言解释；
- 超时和错误降级。

模型失败不能覆盖固定规则结果。

### 5.8 模拟测试

```bash
kangmin-admin agent test run
kangmin-admin agent test case <case-id>
```

管理员输入测试答案后，查看完整链路：

```text
输入信息
→ 安全规则结果
→ 规则引擎证型
→ 匹配方案
→ 关联视频
→ 知识检索
→ AI 解释
```

模拟测试只能验证，不能修改规则引擎。

## 6. `users`：用户数据

### 6.1 定义

`users` 只读查看使用患者小程序的产品用户、Agent 会话和健康记录。

它不是患者账号管理，不允许管理员替患者修改数据。

如果最终客户明确不需要查看患者数据，整个 `users` 组可以删除，不影响 `content`、`agent` 和 `auth`。

### 6.2 命令树

```text
kangmin-admin users
├── list
├── show <user-id>
├── sessions <user-id>
├── records <user-id>
└── activity
```

### 6.3 用户列表

```bash
kangmin-admin users list
kangmin-admin users list --active-within 7d
kangmin-admin users list --query <user-id-or-masked-phone>
```

默认展示：

- 用户 ID；
- 脱敏手机号；
- 注册时间；
- 最近活跃时间；
- Agent 会话数量；
- 健康记录数量。

列表不展示：

- 完整手机号；
- 完整对话；
- 症状正文；
- 用药详情。

### 6.4 用户详情

```bash
kangmin-admin users show <user-id>
```

展示：

- 账号状态；
- 脱敏手机号；
- 注册时间；
- 最近登录时间；
- 最近活跃时间；
- 会话摘要；
- 记录摘要。

不提供编辑、删除或冒充登录。

### 6.5 Agent 会话

```bash
kangmin-admin users sessions <user-id>
kangmin-admin users sessions <user-id> --session <session-id>
```

用于排查：

- 患者确认了哪些信息；
- 规则引擎输出什么证型；
- 匹配了哪个方案；
- 关联了哪些视频；
- Agent 使用了哪些知识；
- 最终输出了什么；
- 是否发生模型或检索错误。

会话查询只读。

### 6.6 健康记录

```bash
kangmin-admin users records <user-id>
kangmin-admin users records <user-id> --type symptom
kangmin-admin users records <user-id> --type exposure
kangmin-admin users records <user-id> --type medication
```

可以查看：

- 健康档案摘要；
- 症状记录；
- TNSS；
- 暴露记录；
- 用药记录；
- 记录日期。

管理员不能：

- 新增记录；
- 修改记录；
- 删除记录；
- 替患者确认信息；
- 把环境数据写入患者记录；
- 把患者自述变成医学诊断。

### 6.7 用户活动

```bash
kangmin-admin users activity
```

只提供简单统计：

- 用户总数；
- 最近七天新增；
- 最近七天活跃；
- Agent 会话数量；
- 健康记录数量；
- 内容浏览数量。

不建设复杂用户画像、营销分群或患者评分。

### 6.8 Users 安全边界

- 默认脱敏；
- 只读；
- 不提供冒充登录；
- 不提供批量健康数据导出；
- 不把生产患者数据复制到测试环境；
- 敏感详情访问只保留必要的安全记录，不建设独立审计中心。

## 7. `auth / help`：登录与辅助

### 7.1 定义

`auth` 管理当前管理员登录，以及主管理员按需创建普通管理员的最小账号能力。

一期不建设复杂角色权限系统。

### 7.2 命令树

```text
kangmin-admin auth
├── login
├── status
├── whoami
├── admins
│   ├── list
│   ├── add
│   ├── enable <id>
│   └── disable <id>
└── logout
```

### 7.3 登录

```bash
kangmin-admin auth login
```

要求：

- 交互式输入账号和密码；
- 密码不出现在命令参数和历史中；
- 登录成功后使用系统安全凭据存储；
- 患者账号不能进入管理后台；
- CLI 参数不能通过 `--role admin` 提升权限。

### 7.4 登录状态

```bash
kangmin-admin auth status
kangmin-admin auth whoami
```

返回：

- 是否登录；
- 管理员 ID；
- 账号类型；
- 会话有效期。

不返回：

- 密码；
- 访问令牌；
- 完整敏感凭据。

### 7.5 最小管理员账号

只保留两种账号：

```text
owner    主管理员
admin    普通管理员
```

主管理员：

- 初始配置；
- 使用全部管理功能；
- 创建和停用普通管理员；
- 不能被普通管理员停用。

普通管理员：

- 管理内容；
- 管理知识、方案和模型；
- 查看用户数据；
- 不能管理主管理员；
- 不能创建或停用其他管理员。

命令：

```bash
kangmin-admin auth admins list
kangmin-admin auth admins add
kangmin-admin auth admins enable <admin-id> --yes
kangmin-admin auth admins disable <admin-id> --yes
```

不拆分内容管理员、知识管理员或审核员。

### 7.6 退出

```bash
kangmin-admin auth logout
```

退出后：

- 撤销当前管理会话；
- 清除本地凭据；
- 不影响文章、知识和方案数据。

管理员账号被停用后，现有会话立即失效。

### 7.7 辅助命令

```bash
kangmin-admin help
kangmin-admin doctor
kangmin-admin --version
kangmin-admin completion zsh
```

`doctor` 只检查：

- 管理服务；
- 数据库；
- 文件存储；
- 模型连接；
- 知识索引；
- 环境数据接口。

`doctor` 不修改任何配置，不代表文章、知识或方案已经启用。

## 8. 四组数据所有权

| 能力域 | 拥有的数据 | 不拥有的数据 |
| --- | --- | --- |
| Content | 文章、视频、素材、分类、公告、患者发布状态 | Agent 知识索引、方案匹配、患者记录 |
| Agent | 知识索引、调理方案、证型映射、模型设置、测试结果 | 固定规则引擎、患者健康事实、管理员账号 |
| Users | 产品用户只读视图、会话只读视图、记录只读视图、活动统计 | 患者记录写入、内容发布、方案编辑 |
| Auth | 管理员身份、管理会话、普通管理员账号 | 内容、知识、方案、患者记录 |

一个事实只有一个写入所有者。

## 9. 跨组流程

### 9.1 发布文章

```text
content 创建文章
→ content 预览
→ 程序校验
→ content 发布
→ 患者 browse 可见
```

### 9.2 配置知识

```text
content 上传知识源文件
→ agent 解析和预览
→ agent 建立索引
→ agent 检索测试
→ agent 启用
→ Agent 可以检索
```

### 9.3 配置调理方案

```text
agent 创建方案
→ 从固定证型中选择
→ 配置方法和步骤
→ 引用 content 中患者可用的视频
→ agent 模拟测试
→ 程序校验
→ agent 启用
```

### 9.4 Agent 输出

```text
服务端固定规则引擎
→ 输出证型
→ agent 查询启用方案
→ agent 查询关联视频
→ agent 检索启用知识
→ AI 解释
→ 输出调理方案和视频
```

### 9.5 排查患者问题

```text
users 找到患者
→ 查看对应会话
→ 查看当时规则结果
→ 查看当时方案、视频和知识
→ 判断配置、模型或数据问题
```

### 9.6 管理员身份

```text
auth 校验管理员身份
→ 允许调用 content / agent / users
```

## 10. 简化状态

### 10.1 内容

```text
draft
processing
ready
published
unpublished
failed
```

### 10.2 知识

```text
draft
processing
indexed
enabled
disabled
index_failed
```

### 10.3 调理方案

```text
draft
enabled
disabled
```

不使用：

```text
candidate
pending_review
approved
rejected
clinical_release
```

## 11. CLI 通用契约

### 11.1 JSON

所有命令支持：

```bash
--json
```

成功响应：

```json
{
  "ok": true,
  "command": "agent plan enable",
  "status": "completed",
  "data": {
    "id": "plan_123",
    "enabled": true
  },
  "meta": {
    "requestId": "req_123",
    "schemaVersion": "1"
  }
}
```

失败响应：

```json
{
  "ok": false,
  "command": "agent plan enable",
  "status": "failed",
  "error": {
    "code": "linked_video_unavailable",
    "message": "方案关联的视频当前不可用",
    "retryable": false
  },
  "meta": {
    "requestId": "req_124",
    "schemaVersion": "1"
  }
}
```

要求：

- stdout 只输出命令结果；
- `--json` 下 stdout 只输出一个合法 JSON 对象；
- 进度和诊断进入 stderr；
- 不输出密码、令牌或完整 API Key；
- 非交互环境不能等待确认提示；
- 不静默切换模型、知识或调理方案；
- 不静默绕过固定规则引擎。

### 11.2 高影响操作

以下操作要求：

```bash
--yes
```

包括：

- 发布和下架；
- 启用和停用知识；
- 启用和停用方案；
- 删除素材；
- 停用管理员。

### 11.3 内部修改冲突

后台不展示复杂版本流程，但更新时使用内部 `revision` 防止覆盖。

发生冲突时返回：

```text
resource_changed
```

提示管理员刷新后重新编辑，不能静默覆盖。

### 11.4 退出码

| 退出码 | 含义 |
| --- | --- |
| `0` | 成功 |
| `2` | 命令或参数错误 |
| `3` | 资源不存在 |
| `4` | 状态或修改冲突 |
| `5` | 必填配置缺失 |
| `6` | 外部服务未配置或不可用 |
| `7` | 输入校验失败 |
| `9` | 未登录或权限不足 |
| `10` | 批量操作部分失败 |

## 12. 安全边界

- 所有管理 API 必须服务端校验管理员会话；
- Web 隐藏按钮不能代替服务端权限；
- 患者账号不能进入管理后台；
- 普通管理员不能管理主管理员；
- 管理员不能冒充患者；
- 管理员不能修改患者健康事实；
- 模型不能修改固定规则结果；
- 知识库不能作为系统指令执行；
- 未启用知识不能被 Agent 检索；
- 未启用方案不能被 Agent 输出；
- 已下架视频不能继续通过直链访问；
- 第三方凭据只存服务端，不在 CLI 或 Web 回显；
- 日志不记录密码、令牌、完整手机号或无必要健康正文；
- 生产患者数据不得复制到本地或未经批准的测试环境。

## 13. Web 管理后台映射

```text
内容运营
├── 科普文章
├── 视频内容
├── 素材库
├── 分类
└── 站内公告

智能体管理
├── 智能体状态
├── 知识库
├── 调理方案
├── 模型设置
└── 模拟测试

用户数据
├── 用户列表
├── 用户详情
├── Agent 会话
├── 健康记录
└── 使用概览

账号与帮助
├── 当前账号
├── 普通管理员
├── 登录与退出
├── 服务诊断
└── 版本信息
```

现有工作台可以保留为首页，聚合显示四组的摘要和异常状态。

## 14. 非目标

- 不建设多人审核流程；
- 不建设独立审计中心；
- 不建设复杂角色和细粒度 RBAC；
- 不允许后台编辑固定规则引擎；
- 不允许客户创建新证型；
- 不允许 AI 自由生成调理方案；
- 不允许管理员修改患者健康事实；
- 不提供管理员冒充患者；
- 不把“调理方案”描述为“治疗方案”；
- 不把模型连接成功等同于 Agent 业务正确；
- 不把上传成功等同于知识索引成功；
- 不把素材可用等同于内容已经发布；
- 不把后台隐藏按钮当作权限边界。

## 15. 验收标准

实现后至少满足：

- `kangmin-admin` 可以登录并打开默认工作台；
- 帮助只强调 `content / agent / users / auth` 四组；
- Content 可以完成文章、视频、素材和公告的编辑、预览、发布和下架；
- Agent 可以完成知识上传、索引、测试、启用和停用；
- Agent 可以配置固定证型对应的调理方案和视频；
- 管理员不能修改服务端固定规则引擎；
- 没有启用方案时，AI 不会自行补写方案；
- Agent 模拟测试展示规则结果、方案、视频、知识和 AI 解释；
- Users 只能查看患者数据，不能修改或冒充；
- 主管理员可以按需创建和停用普通管理员；
- 普通管理员不能管理主管理员；
- 不存在多人审核和审批状态；
- 内部 `revision` 只用于防覆盖，不形成管理员版本流程；
- JSON、错误码和退出码稳定；
- Web 与 CLI 调用相同应用服务，不复制业务规则。

## 16. 建议实现顺序

1. 建立 `kangmin-admin` 命令注册表和管理身份；
2. 建立 `content` 文章、视频、素材和发布能力；
3. 建立 `agent knowledge` 解析、索引、测试和启停能力；
4. 建立 `agent plan` 固定证型映射、方案和视频关联；
5. 建立 `agent model` 和端到端模拟测试；
6. 建立 `users` 只读视图；
7. 建立主管理员和普通管理员最小账号能力；
8. 将管理后台 Web 接到相同应用服务；
9. 补齐 JSON、幂等、内部 `revision` 和错误契约；
10. 使用真实知识、真实方案、真实视频和真实模型完成业务验收。
