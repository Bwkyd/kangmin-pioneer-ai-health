# 抗敏先锋患者端 CLI 命令行设计

- 状态：四组命令结构已确认，命令细节待实现
- 日期：2026-07-31
- 产品入口：`kangmin` CLI 与患者小程序
- 设计范围：患者端命令、应用服务、数据归属和小程序映射
- 不包含：管理员 Web 后台、管理员命令、临床内容批准和具体数据源采购
- 与综合设计关系：患者端命令以本文为准；管理员端继续由综合设计单独约束

## 1. 结论

患者端能力统一归为四组：

```text
1. agent      对话与智能分析
2. record     患者主动保存的健康事实
3. browse     外部环境和已发布内容
4. account    身份、授权、设置与个人数据权利
```

对应 CLI：

```bash
kangmin
kangmin agent ...
kangmin record ...
kangmin browse ...
kangmin account ...
```

`kangmin` 是最高频主入口，等价于启动 `agent` 对话。患者不需要先理解内部模块或输入 `agent start`。

患者小程序和 CLI 调用同一组患者应用服务。小程序不是在移动端执行 Shell 命令，而是把相同命令契约呈现为页面、按钮、表单和连续对话。

四组是业务能力和数据所有权分组，不等于四个小程序底部导航。

## 2. 已确认的小程序 UI 约束

当前患者端导航和记录 UI 保持不变：

```text
首页｜问助手｜中央＋｜日历｜我的
```

必须保留：

- 首页的 Agent、科普和记录入口；
- “问助手”对话入口；
- 中央“＋”新增症状记录；
- 日历/列表切换；
- TNSS 症状评分；
- 症状趋势；
- 症状与过敏原暴露按同一天关联；
- “我的”中的健康档案入口；
- 当前记录页面的表单和信息层级。

不得为了匹配四组 CLI：

- 把底部导航强制改成四个 Tab；
- 新增一个与现有日历重复的“记录”主页面；
- 移动或重做中央“＋”的症状记录交互；
- 把健康档案从“我的”中移走；
- 把环境数据自动写入患者记录。

## 3. 三层命名

同一能力在产品、CLI 和代码层使用适合各自场景的名称：

| 能力域 | 患者文案 | CLI | 应用服务 |
| --- | --- | --- | --- |
| Agent | 问助手、诊一诊 | `agent`，默认入口为 `kangmin` | Agent Application Service |
| Record | 记录、日历、健康档案 | `record` | Record Application Service |
| Browse | 学一学、浏览、当前环境 | `browse` | Browse Application Service |
| Account | 我的 | `account` | Account Application Service |

命名原则：

- `agent` 不使用 `consult`，避免把产品描述成在线诊断或医疗问诊；
- `record` 不使用宽泛的 `health`，避免环境、科普、Agent 和设置继续混入；
- `browse` 不使用 `learn`，因为空气和花粉环境信息不属于学习；
- `browse` 不使用 `content`，患者不需要理解后台资源模型；
- `account` 不使用狭窄的 `auth`，因为“我的”还包含授权、设置、消息和数据权利；
- 小程序继续使用自然中文，CLI 使用稳定英文命令，内部代码使用明确领域名称。

## 4. 四组的数据所有权

| 能力域 | 拥有的数据 | 不拥有的数据 |
| --- | --- | --- |
| Agent | 对话会话、确认过程、规则执行结果、决策凭证、回答反馈 | 患者健康记录、账号、内容发布状态 |
| Record | 健康档案、症状、TNSS、暴露、用药、日期关联 | 外部实时环境、文章视频、Agent 临床判断 |
| Browse | 环境数据快照、已发布文章/视频/通用方案的只读视图 | 患者健康事实、账号设置、后台草稿 |
| Account | 患者身份、会话、授权、提醒、通知、数据请求 | 症状事实、临床规则、内容正文 |

一个事实只能有一个写入所有者。其他能力域只能通过公开查询契约读取，不能直接修改其存储。

## 5. 顶层命令

```text
kangmin
├── agent
├── record
├── browse
├── account
├── help
├── doctor
├── completion
└── --version
```

患者公开帮助只突出四组：

```text
agent      与鼻健康助手对话
record     管理自己的健康记录
browse     浏览环境、科普文章和视频
account    管理账号、授权和设置
```

`help`、`doctor`、`completion` 和 `--version` 是全局辅助命令，不构成第五组业务能力。

## 6. `agent`：对话与智能分析

### 6.1 命令树

```text
kangmin agent
├── start
├── continue
├── resume <session-id>
├── exec <message>
├── sessions
│   ├── list
│   └── show <session-id>
└── feedback <session-id>
```

快捷入口：

```bash
kangmin
kangmin "我最近鼻塞，晚上比较严重"
kangmin --continue
kangmin --resume <session-id>
```

等价命令：

```bash
kangmin agent start
kangmin agent start --message "我最近鼻塞，晚上比较严重"
kangmin agent continue
kangmin agent resume <session-id>
```

### 6.2 交互式对话

```bash
kangmin
```

启动连续对话，负责：

- 显示医疗边界和隐私提示；
- 获取必要同意；
- 接收患者自然语言；
- 展示服务端规则决定的补问；
- 展示模型提取的待确认候选；
- 允许患者确认、修改、忽略或回答“不知道”；
- 显示安全阻断、信息不足、无匹配或正式结果；
- 展示当前回答使用的正式来源。

### 6.3 固定执行顺序

```text
同意
→ 收集信息
→ 模型提取待确认候选
→ 患者确认
→ 固定安全规则
→ 固定适用范围规则
→ 固定严重程度规则
→ 固定证型规则
→ 查询已批准方案
→ 检索已批准、已索引、已发布知识
→ 模型解释结构化结果
→ 输出校验
→ 保存决策凭证（已登录且患者同意时）
```

服务端规则是 `nextQuestions` 的唯一来源。前端和模型不得复制或自行扩展临床分支。

### 6.4 模型职责

模型只能：

- 从自然语言提取待确认候选；
- 将规则结果解释成自然中文；
- 总结当前会话中已经确认的信息；
- 基于本次检索结果组织引用。

模型不能：

- 决定证型或严重程度；
- 把 `unknown` 当成 `no`；
- 在冲突、无命中或信息不足时猜测；
- 新增穴位、疗程、力度、剂量、禁忌或疗效；
- 在没有正式方案时使用模型常识补齐；
- 读取草稿、待审核或已下架知识；
- 执行 `record`、`account` 或任何管理员写操作。

模型超时、非法 JSON 或解释失败时，固定规则结果仍然有效，不能被空回答或错误回答覆盖。

### 6.5 会话恢复

```bash
kangmin agent continue
kangmin agent resume <session-id>
kangmin agent sessions list
kangmin agent sessions show <session-id>
```

约束：

- 只有已登录患者可以跨设备恢复历史；
- 患者只能读取自己的会话；
- 恢复时校验会话版本；
- 新建、回退或修改答案后，旧异步请求不得写回当前会话；
- 会话正文不得进入普通调试日志；
- 决策凭证与聊天正文分开保存。

### 6.6 非交互调用

```bash
kangmin agent exec "总结我最近确认过的记录" --json
```

用于：

- 自动化测试；
- 小程序后端任务；
- 其他受控 Agent；
- 机器集成。

非交互模式不能停在确认提示。需要患者确认、登录或补充信息时，返回结构化状态，不得假设答案。

### 6.7 反馈

```bash
kangmin agent feedback <session-id> --rating helpful
kangmin agent feedback <session-id> --rating unhelpful --reason "解释不清楚"
```

反馈用于产品质量分析，不得自动修改临床规则、知识发布状态或模型权限。

## 7. `record`：患者健康记录

### 7.1 定义

`record` 只管理患者本人主动填写、确认并保存的健康事实。

它统一底层命令和数据契约，不改变现有记录 UI。

### 7.2 命令树

```text
kangmin record
├── overview
├── profile
│   ├── show
│   └── update
├── symptom
│   ├── add
│   ├── list
│   ├── show <id>
│   ├── update <id>
│   └── delete <id>
├── exposure
│   ├── add
│   ├── list
│   ├── show <id>
│   ├── update <id>
│   └── delete <id>
├── medication
│   ├── add
│   ├── list
│   ├── show <id>
│   ├── update <id>
│   └── delete <id>
├── calendar
└── trend
```

### 7.3 记录概览

```bash
kangmin record overview
```

返回当前患者自己的摘要：

- 最近症状记录日期；
- 本月记录次数；
- 连续记录天数；
- 最近一次 TNSS；
- 最近暴露记录；
- 最近用药记录；
- 数据读取状态。

概览不能在记录读取失败时伪装成“暂无记录”。

### 7.4 健康档案

```bash
kangmin record profile show
kangmin record profile update
```

包含当前已确认的患者自填信息：

- 姓名或称呼；
- 出生日期；
- 性别；
- 既往过敏史；
- 已知过敏情况；
- 常见诱因；
- 其他患者主动填写的说明。

健康档案是患者自述，不代表门诊诊断。小程序继续从“我的 → 健康档案”进入。

### 7.5 症状与 TNSS

```bash
kangmin record symptom add \
  --date 2026-07-31 \
  --sneezing 2 \
  --rhinorrhea 1 \
  --congestion 2 \
  --itching 1 \
  --idempotency-key <key>
```

查询：

```bash
kangmin record symptom list --from 2026-07-01 --to 2026-07-31
kangmin record symptom show <id>
```

修改：

```bash
kangmin record symptom update <id> \
  --congestion 3 \
  --expected-version 2 \
  --idempotency-key <key>
```

约束：

- 每一项 TNSS 分值必须使用正式允许范围；
- 总分由服务端计算，客户端不能提交权威总分；
- 本地日期、记录来源和创建时间分开保存；
- 创建使用幂等键；
- 更新使用当前版本；
- 患者只能访问自己的记录；
- 日历、列表和趋势读取同一份服务端事实。

小程序继续使用中央“＋”新增、日历选择日期、列表查看和趋势图，不改现有交互。

### 7.6 环境暴露记录

```bash
kangmin record exposure add \
  --date 2026-07-31 \
  --factor pollen \
  --factor dust \
  --idempotency-key <key>
```

查询和修改：

```bash
kangmin record exposure list
kangmin record exposure show <id>
kangmin record exposure update <id> --expected-version 1
kangmin record exposure delete <id> --expected-version 2 --yes
```

约束：

- 暴露是患者回忆和自述；
- 暴露不等于医学确认的过敏原；
- “未识别明确因素”与具体因素互斥；
- 与症状只按记录日期关联；
- 同一天有关联不代表因果；
- 环境数据只能预填候选，患者确认后才能保存；
- 删除按数据保留规则处理，不保证立即物理删除。

### 7.7 用药记录

```bash
kangmin record medication add
kangmin record medication list
kangmin record medication show <id>
kangmin record medication update <id>
kangmin record medication delete <id> --yes
```

用药记录保存患者自述的药品、日期、使用情况和备注，不生成处方，不评价疗效，不自动改变 Agent 规则结果。

### 7.8 日历和趋势

```bash
kangmin record calendar --month 2026-07
kangmin record trend --from 2026-07-01 --to 2026-07-31
```

日历和趋势是现有记录的只读投影：

- 不能维护第二份症状事实；
- 不能用缺失数据填充虚假趋势；
- 读取失败与空数据必须区分；
- 趋势仅用于患者回顾，不代表诊断或疗效评价。

## 8. `browse`：环境与已发布内容

### 8.1 定义

`browse` 负责所有不属于患者个人事实的只读信息：

- 当前环境；
- 天气和空气质量；
- 花粉过敏风险；
- 已发布科普文章；
- 已发布操作视频；
- 允许患者公开浏览的通用方案。

### 8.2 命令树

```text
kangmin browse
├── environment
│   ├── current
│   ├── forecast
│   └── refresh
├── article
│   ├── list
│   ├── categories
│   ├── search <query>
│   └── show <id>
├── video
│   ├── list
│   ├── categories
│   ├── search <query>
│   └── show <id>
├── plan
│   ├── list
│   └── show <id>
└── search <query>
```

### 8.3 浏览首页

```bash
kangmin browse
```

返回适合患者浏览的聚合内容：

- 当前环境卡片；
- 推荐文章；
- 推荐视频；
- 最近更新内容；
- 分类入口。

聚合结果仍然分别来自环境和已发布内容服务，不复制它们的权威事实。

### 8.4 当前环境

```bash
kangmin browse environment current
kangmin browse environment current --city 成都
kangmin browse environment forecast --days 3
kangmin browse environment refresh
```

小程序流程：

```text
患者点击获取当前位置
→ 小程序请求定位权限
→ 获得当次经纬度
→ 服务端调用已配置环境数据提供方
→ 统一为环境快照
→ 返回小程序展示
```

当前环境可以包含：

- 城市或区县；
- 天气现象；
- 温度和体感温度；
- 湿度；
- 风力和风向；
- 降水；
- 中国 AQI；
- PM2.5、PM10；
- 主要污染物；
- 花粉过敏风险；
- 数据来源；
- 数据更新时间；
- 空间精度或覆盖范围。

### 8.5 环境信息边界

- 获取位置必须由患者主动触发；
- 拒绝定位后允许手动选择城市；
- 不在后台持续跟踪位置；
- 默认不长期保存精确经纬度；
- 第三方凭据只保存在服务端；
- 小程序不得直接调用带密钥的第三方 API；
- 环境提供方必须通过 Provider 接口接入，不能写死在前端；
- 返回值必须携带来源和更新时间；
- 缓存数据必须标记数据时间，不能冒充刚刚更新；
- 花粉过敏风险指数不能宣传为实测花粉浓度；
- 环境信息不能自动变成患者过敏史或暴露记录。

环境查询失败要区分：

```text
location_permission_denied
location_unavailable
provider_unconfigured
provider_timeout
provider_unavailable
pollen_not_supported
stale_cache
```

### 8.6 文章

```bash
kangmin browse article list
kangmin browse article categories
kangmin browse article search "鼻塞"
kangmin browse article show <id>
```

只读取：

- 已审核；
- 已发布；
- 当前版本有效；
- 媒体可用；
- 面向患者可见；
- 保留医疗免责声明的文章。

### 8.7 视频

```bash
kangmin browse video list
kangmin browse video categories
kangmin browse video search "鼻腔护理"
kangmin browse video show <id>
```

视频详情可以包含：

- 标题和简介；
- 视频分类；
- 方法标签；
- 经审核步骤；
- 风险提示；
- 禁忌事项；
- 视频媒体；
- 医疗免责声明。

下架后列表和媒体直链都不可继续访问。

### 8.8 通用方案

```bash
kangmin browse plan list
kangmin browse plan show <id>
```

仅展示后台明确允许患者公开浏览的已批准方案。

边界：

- 患者主动浏览通用方案属于 `browse`；
- Agent 根据固定规则匹配个人结果属于 `agent`；
- 浏览通用方案不能改变患者证型或决策凭证；
- 未完成临床批准、视频关联或发布门禁的方案不可见。

### 8.9 搜索

```bash
kangmin browse search "换季鼻敏感"
```

搜索只覆盖患者当前有权读取的已发布文章、视频和通用方案，不搜索：

- 后台草稿；
- Agent 私有知识分块；
- 其他患者数据；
- 管理员资料；
- 已下架媒体。

## 9. `account`：我的账号

### 9.1 定义

`account` 对应小程序“我的”，负责身份、会话、授权、设置、消息和个人数据请求。

健康档案虽然从“我的”进入，但数据所有者仍是 `record`，不能写入账号对象。

### 9.2 命令树

```text
kangmin account
├── login
├── status
├── profile
│   ├── show
│   └── update
├── consent
│   ├── show
│   └── update
├── privacy
├── reminder
│   ├── show
│   └── update
├── notification
│   ├── list
│   └── read <id>
├── data
│   ├── export
│   ├── deletion-request
│   └── request-status <id>
├── deactivate
└── logout
```

### 9.3 登录和会话

```bash
kangmin account login
kangmin account status
kangmin account logout
```

要求：

- 小程序使用已验证手机号建立患者身份；
- 内部只使用供应商无关的 `userId`；
- CLI 凭据保存在系统安全存储；
- 不把令牌写入命令历史、仓库或普通配置文件；
- 患者会话不能调用管理员 API；
- 退出登录撤销当前会话，不删除健康记录；
- 会话过期返回明确状态，不伪装成资源不存在。

状态响应不得输出完整手机号、访问令牌或健康正文。

### 9.4 账号资料

```bash
kangmin account profile show
kangmin account profile update
```

账号资料只包含登录标识和产品身份信息，例如：

- `userId`；
- 脱敏手机号；
- 昵称；
- 账号状态；
- 创建时间。

出生日期、过敏史、诱因等属于 `record profile`，不属于账号资料。

### 9.5 同意和隐私

```bash
kangmin account consent show
kangmin account consent update
kangmin account privacy
```

包含：

- 隐私政策；
- 医疗边界；
- 健康数据使用授权；
- Agent 会话保存授权；
- 定位用途说明；
- 授权版本和确认时间；
- 撤回授权后的影响。

撤回授权不能静默删除数据，也不能继续执行已经失去授权的读取或写入。

### 9.6 提醒和通知

```bash
kangmin account reminder show
kangmin account reminder update
kangmin account notification list
kangmin account notification read <id>
```

包括：

- 每日记录提醒；
- 健康内容提醒；
- 站内消息；
- 服务通知；
- 消息已读状态。

通知属于患者个人消息，不归入公共 `browse`。

### 9.7 数据权利

以下命令预留在 `account`，具体范围、保留期限和处理时限需另行确认：

```bash
kangmin account data export
kangmin account data deletion-request --yes
kangmin account data request-status <id>
kangmin account deactivate --yes
```

高影响操作要求：

- 已登录；
- 必要时重新验证身份；
- 明确确认；
- 幂等键；
- 审计事件；
- 返回请求状态；
- 不把“提交删除申请”描述成“已经物理删除”。

## 10. 跨组业务流程

### 10.1 浏览环境后记录暴露

```text
browse.environment.current
→ 返回环境快照
→ 患者点击“记录今天的环境暴露”
→ 只预填候选
→ 患者确认实际接触
→ record.exposure.add
```

环境快照不能自动成为患者事实。

### 10.2 Agent 读取记录

```text
account 校验身份和授权
→ agent 请求 record 只读快照
→ record 返回患者已确认事实
→ agent 固定规则执行
```

Agent 不直接查询 Record 数据库，也不能修改原记录。

### 10.3 Agent 使用已发布内容

```text
管理员完成批准和发布
→ browse 暴露患者可读版本
→ Agent Knowledge Port 暴露允许检索的已发布版本
→ agent 在本次检索中使用并生成引用
```

患者浏览发布和 Agent 知识发布是两个门禁，不能因为文章可浏览就自动允许进入 RAG。

### 10.4 Agent 结果与记录页面

Agent 决策凭证由 `agent` 拥有。记录页面如需展示“最近评估”，通过只读摘要读取，不复制或修改决策事实。

## 11. 登录与权限矩阵

| 能力 | 未登录 | 已登录 |
| --- | --- | --- |
| 一次性 Agent 体验 | 允许 | 允许 |
| 保存 Agent 会话 | 不允许 | 患者确认后允许 |
| 恢复历史会话 | 不允许 | 允许读取本人会话 |
| 查看公开文章和视频 | 允许 | 允许 |
| 查看公开环境信息 | 允许，但需定位授权或手选城市 | 允许 |
| 写健康档案 | 不允许 | 允许 |
| 写症状、暴露和用药 | 不允许 | 允许 |
| 查看个人日历和趋势 | 不允许 | 允许 |
| 查看账号状态 | 返回未登录状态 | 允许 |
| 修改授权和提醒 | 不允许 | 允许 |
| 导出、删除或停用申请 | 不允许 | 重新验证后允许 |

匿名 Agent 登录后，必须再次询问是否保存登录前会话，不能自动绑定。

## 12. CLI 通用契约

### 12.1 输出模式

人类交互模式使用易读文本；机器模式统一使用：

```bash
--json
```

成功响应：

```json
{
  "ok": true,
  "command": "record symptom add",
  "status": "completed",
  "data": {
    "id": "sym_123",
    "version": 1
  },
  "meta": {
    "schemaVersion": "1",
    "requestId": "req_123",
    "timestamp": "2026-07-31T08:00:00Z"
  }
}
```

失败响应：

```json
{
  "ok": false,
  "command": "record symptom update",
  "status": "failed",
  "error": {
    "code": "version_conflict",
    "message": "记录已更新，请重新读取后再修改",
    "retryable": false
  },
  "meta": {
    "schemaVersion": "1",
    "requestId": "req_124"
  }
}
```

要求：

- stdout 只输出命令结果；
- `--json` 下 stdout 只输出一个合法 JSON 对象；
- 进度、诊断和调试信息进入 stderr；
- 不输出访问令牌、完整手机号或无必要健康正文；
- 非交互环境不能等待确认输入；
- 需要确认时返回 `confirmation_required`；
- 不静默切换模型、规则版本或环境数据源。

### 12.2 退出码

| 退出码 | 含义 |
| --- | --- |
| `0` | 成功 |
| `2` | 命令或参数错误 |
| `3` | 资源不存在 |
| `4` | 状态或版本冲突 |
| `5` | 同意、确认或正式内容缺失 |
| `6` | 外部数据源未配置或不可用 |
| `7` | 输入校验失败 |
| `8` | 安全规则阻断 |
| `9` | 未登录或权限不足 |
| `10` | 批量操作部分失败 |

JSON `error.code` 比退出码更具体，并保持向后兼容。

### 12.3 写操作

除登录和认证交换外，所有患者数据写操作要求：

- 服务端可信身份；
- 资源归属校验；
- 创建时使用幂等键；
- 更新和删除时使用当前版本；
- 返回新版本；
- 返回审计或操作凭证 ID；
- 重试不能产生重复记录；
- 不把读取失败解释为空数据；
- 不在客户端生成权威医学字段。

## 13. 数据与临床安全

- 患者只能读取和修改自己的 Record 数据；
- 管理员身份不能冒充患者调用患者写操作；
- 模型不能直接写患者健康事实；
- `unknown` 是正式状态，不等于否；
- 高危、非适用和关键信息未知时优先阻断；
- 暴露记录不等于医学确认过敏原；
- 趋势不等于诊断或疗效；
- 环境风险不等于个人发病原因；
- 只有已批准内容可以进入正式方案；
- 只有符合知识发布门禁的版本可以进入 Agent 检索；
- 日志不记录完整手机号、令牌、精确位置或无必要健康正文；
- 生产患者数据不得复制到本地、集成环境或未经批准的测试环境。

## 14. 小程序现有 UI 映射

```text
首页
├── 诊一诊                    → agent
├── 学一学                    → browse
├── 今日过敏原记录             → record
├── 环境信息卡（可新增）        → browse
└── 推荐文章/视频              → browse

问助手                        → agent

中央＋
└── 新增症状记录               → record

日历
├── 症状记录                   → record
├── TNSS                      → record
├── 日历/列表切换              → record
├── 过敏趋势                   → record
└── 当天暴露关联               → record

我的
├── 登录账号                   → account
├── 健康档案                   → record
├── 症状记录入口               → record
├── 鼻健康科普                 → browse
├── 提醒设置                   → account
├── 隐私与授权                 → account
└── 关于与反馈                 → account
```

四组能力允许从多个小程序页面进入。页面位置不决定数据所有权。

## 15. 禁止的边界穿透

禁止：

- 小程序直接访问数据库；
- 小程序复制临床决策树；
- Agent 直接调用 Record 写处理器；
- Browse 自动创建患者暴露记录；
- Account 保存过敏史、TNSS 或用药事实；
- Record 保存第三方实时环境作为患者已确认事实；
- 根据环境指数自动确认患者过敏原；
- 根据文章或视频自动改变 Agent 证型；
- 患者 CLI 暴露管理员内容发布、知识索引或临床批准命令；
- 新 `src/` 导入 `legacy/` 的业务状态或框架模块。

## 16. 非目标

- 本文不修改现有记录 UI；
- 本文不实现 CLI、小程序、API 或数据库；
- 本文不批准任何临床候选；
- 本文不确定环境数据供应商的采购和商务条款；
- 本文不把花粉过敏风险描述成实测花粉浓度；
- 本文不设计管理员 Web 后台；
- 本文不提供管理员冒充患者能力；
- 本文不确认数据删除的最终保留期限；
- 本文不恢复未被当前范围明确引用的历史需求。

## 17. 验收标准

设计实现后至少满足：

- `kangmin` 直接启动 Agent；
- 患者帮助只强调 `agent / record / browse / account`；
- `record` 统一记录服务，但现有记录 UI、中央“＋”和日历保持不变；
- 健康档案仍从“我的”进入；
- 环境信息进入 `browse`，不进入 `record`；
- 环境数据只有经患者确认后才能形成暴露记录；
- 文章、视频和通用方案只读取已发布的当前有效版本；
- 患者浏览内容与 Agent 知识检索保持独立门禁；
- Agent 不产生临床规则、证型、穴位或疗程；
- `unknown`、冲突、无命中和信息不足不会被猜测补齐；
- 所有患者记录写入都有身份、幂等和版本控制；
- 读取失败与空数据明确区分；
- 未登录用户不能保存或读取个人历史；
- JSON 输出、错误码和退出码稳定；
- 患者端不出现任何管理员命令。

## 18. 建议实现顺序

1. 定义四组命令注册表和共享 JSON 错误契约；
2. 建立患者身份、会话和资源归属校验；
3. 将现有症状、档案、暴露和用药能力接到 `record` 服务，保持 UI 不变；
4. 建立 `agent` 会话状态机、规则端口和决策凭证；
5. 建立 `browse` 的文章、视频和通用方案只读接口；
6. 接入环境 Provider、定位授权和手动城市降级；
7. 完成 `account` 的登录、授权、提醒和通知；
8. 接入小程序薄壳并验证四组跨域流程；
9. 补齐非交互 CLI、JSON 合约和端到端测试；
10. 在临床批准、真实数据源和患者授权满足后完成真实业务验收。
