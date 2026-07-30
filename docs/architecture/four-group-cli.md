# 四组 CLI 命令模型

## 顶层边界

```text
kangmin
├── consult   核心：问诊、安全筛查、补问、辨证结果和获批方案
├── health    核心：健康档案、过敏原记录、症状/量表和花粉状态
├── content   次要：学一学、文章、视频及其发布生命周期
└── control   次要：临床候选、审批、能力状态和审计
```

`--help`、`--version` 和 `--json` 是全局接口，不构成第五组业务命令。

## 计划命令

### `consult`（核心）

- `consult session start|answer|status`
- `consult safety check`
- `consult result show`
- `consult plan show`

固定顺序为安全筛查、资格判断、严重程度、证型、获批方案。缺少关键输入、规则版本或临床批准时停止，不把 `unknown` 当成安全。模型只能解释结构化结果。

### `health`（核心）

- `health profile show|update`
- `health allergen record|list|show|update`
- `health symptom record|list`
- `health scale record|history`
- `health pollen status`

过敏原暴露是用户自述事实，不直接生成因果结论。`pollen status` 在数据源、地区和更新频率确认前返回外部阻塞。

### `content`（次要）

- `content learn list|show`
- `content article create|import|preview|publish|unpublish`
- `content video create|preview|submit|publish|unpublish`

用户端只读取已发布且资源有效的内容。导入失败、正文为空、资源失效、待审核或已下架内容均不可发布或读取。

### `control`（次要）

- `control candidate list|show|register|diff`
- `control approval status|approve|reject`
- `control capability list|show|check`
- `control audit list|show`

临床候选保留来源、版本、差异、审核人和审核时间。未经批准的候选不得进入正式方案、模型提示词、RAG 或用户内容。

## Issue 归属

| Issue | 类型 | 主归属 |
| --- | --- | --- |
| #69 | 聚合：过敏原、视频、文章 | `health allergen`、`content article/video` |
| #70 | 聚合：内容发布 | `content` |
| #71 | 聚合：临床方案与安全 | `consult`、`control` |
| #88～#98 | 临床候选与安全候选 | `control candidate`，批准后由 `consult` 消费 |
| #99 | 临床审批门禁 | `control approval` |
| #101 | 花粉监测 | `health pollen status` |

聚合 Issue 不重复生成第五套实现。Issue #121 是本次工程容器，不属于产品功能。

## 输出契约

机器输出：

```json
{
  "ok": true,
  "command": "control capability list",
  "data": {},
  "meta": {
    "schemaVersion": "1"
  }
}
```

退出码：

| 退出码 | 含义 |
| --- | --- |
| `0` | 成功 |
| `2` | 命令或参数错误 |
| `3` | 资源不存在 |
| `4` | 状态或版本冲突 |
| `5` | 需要临床批准 |
| `6` | 外部条件阻塞 |
| `7` | 输入校验失败 |

JSON 模式下 stdout 只输出契约数据；人类提示和诊断信息使用 stderr。读取/预览与修改/发布分离，有副作用操作必须支持显式确认和非交互调用。
