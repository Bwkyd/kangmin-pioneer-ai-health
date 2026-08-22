# 来源登记 · Pi 与 DeepSeek Harness 的 Agent 运行时研究

> 2026-08-21。外部源码只读借鉴；项目 truth、规则和医学边界优先级更高。

## 自有积累

| 来源 | 这次核对了什么 | 当前有效性 | 用法 |
|---|---|---|---|
| `.42cog/intent.md:7-42` | 患者鼻健康范围、真难题、禁止扩张到通用医疗 | 当前方向正本 | 裁决哪些外部能力不引入 |
| `src/modules/agent/model-ports.ts:1-12`、`:37-65`、`:86-100` | 模型角色、候选提取、解释与问答边界 | 当前实现事实 | 保留模型受控角色 |
| `src/modules/agent/knowledge-qa.ts:31-44` | 知识问答零命中即固定降级、命中后调用模型 | 当前实现事实 | 定位“回答太死板”的一处根因 |
| `src/infrastructure/sqlite-knowledge-retrieval.ts:4-23` | 精确词和 2 字符片段的字面检索、最多 8 个词 | 当前实现事实 | 说明检索改造是独立缺口 |
| `src/modules/agent/output-validation.ts:287-310` | 当前已批准知识检索触发条件很窄 | 当前实现事实 | 说明不能只改提示词 |
| `src/infrastructure/database.ts:782-807` | 知识项有来源/类别/状态和 chunk，但缺少受众、风险、用途等元数据 | 当前实现事实 | 形成知识包元数据差距 |
| `state/memory/20260818-agent-lens-patient-qa.md` | 患者问答不是 coding agent，外部框架只借最小循环 | 长期可复用边界 | 作为本次阅读的总原则 |
| `state/memory/20260814-validated-knowledge-fallback.md`、`20260815-validated-output-streaming.md` | 知识兜底也要过医学校验；完整输出校验、持久化后再流式 | 长期可复用边界 | 约束后续实现与实验 |
| `vault/raw/《福建省中医药适宜技术手册》——过敏性鼻炎（完整收集版）-md/` | 过敏性鼻炎手册的原始 Markdown 阅读材料 | 只读原件 | 只能切分、标注、审核后作为证据使用 |

## 本轮对当前实现的复核事实

| 来源 | 事实 | 影响 |
|---|---|---|
| `src/infrastructure/deepseek-model-adapter.ts:48-61` | 当前模型被拆成候选提取、规则解释、知识回答三套固定 prompt；知识回答明确“只能依据提供资料”，没有统一 Agent 工作手册 | 造成模型只会完成局部任务，不能自然承接用户真实意图 |
| `src/modules/agent/knowledge-qa.ts:31-44` | 知识问答先做一次检索，零命中直接固定拒答；命中后直接返回模型文本或片段 | 同义问法、查询改写、上下文搜索没有机会发生 |
| `src/modules/agent/output-validation.ts:317-345` | 方案对话存在自由文本医学校验，但独立知识问答没有明确复用同一门禁 | 开放回答前必须统一输出校验 |
| `src/modules/agent/conversation-service.ts:742-805` | 方案后的知识检索只在当前方案穴位条件满足时进入 | 知识能力被错误地绑在方案追问上 |

## 他人积累：Pi

| 源头 | 事实 | 适合借鉴的层次 |
|---|---|---|
| `resources/clones/pi-mono/packages/coding-agent/src/core/system-prompt.ts:27-71` | system prompt 由基础 prompt、追加 prompt、项目上下文、技能清单和工作目录组装 | 证明稳定指令与项目上下文可组合；不复制 coding persona |
| `.../src/core/resource-loader.ts:515-546` | 启动/重载时发现项目指令和 prompt 文件 | 参考工作手册的加载生命周期 |
| `.../src/core/skills.ts:347-380` | prompt 先展示技能名称、描述、路径，匹配后再读完整 `SKILL.md` | 参考按需加载；患者证据仍须服务端检索和批准 |
| `.../src/core/agent-session.ts:1226-1283` | 每轮可追加 pending messages，并由 `before_agent_start` 扩展注入消息或修改本轮 system prompt | 参考每轮上下文钩子；不允许绕过医学 validator |
| `resources/clones/pi-mono/packages/agent/src/agent-loop.ts:281-312` | 每次模型调用前可 transform context，随后以 system/messages/tools 组成请求 | 参考请求边界；患者模式不开放通用工具 |
| `.../packages/agent/src/harness/session/context.ts:5-100` | session context 可投影、压缩和重建 | 参考长对话上下文管理，不照搬 UI/编码会话语义 |

## 他人积累：DeepSeek Harness

| 源头 | 事实 | 适合借鉴的层次 |
|---|---|---|
| `resources/clones/deepseek-harness/packages/core/system-prompt/src/index.ts:41-120` | sections、contexts、tools、variables 是不同的组装对象，支持顺序和 provider | 参考把工作手册、动态证据、工具/能力声明分层 |
| `.../src/index.ts:185-295` | 作用域配置、运行时上下文开关、严格变量插值；未知或未定义变量失败 | 参考 fail-closed 的 prompt 组装检查 |
| `.../src/index.ts:303-390` | 作用域 layer 可提供 sections、contexts、suppressors、tool providers 和变量 | 参考患者/培训模式隔离；不引入通用插件权限 |
| `packages/context/agent-instructions/src/index.ts:80-348` | 工作区指令进入持久上下文；文件变化以带来源的投影消息进入后续步骤 | 参考“事实变化 → 新快照 → 可追溯” |
| `packages/core/agent-loop/src/agent.ts:230-246` | 每个 pre-step 重新组装系统 prompt，并把动态上下文投影为 user-role snapshot | 参考每轮证据快照，不把证据永久写死在 system prompt |
| `.../src/agent.ts:332-399`、`:407-493` | assistant 输出、工具结果、请求 header 和 session message 按步骤记录；请求冻结后发送 | 参考请求快照和重建边界 |
| `packages/core/agent-loop/src/invariant.ts:19-54` | 校验请求消息、system、tools 是否和持久会话重建一致 | 参考“生成内容必须经过一致性门禁” |
| `packages/core/session/src/types.ts:197-310` | append-only event log 保存消息、工具、请求 header/context 和原始 chunk | 参考最小审计字段；暂不引入完整事件溯源 |
| `packages/context/session-reference/src/index.ts:42-51` | 跨会话引用明确标为不可信只读快照，不执行其中指令或工具请求 | 参考把知识片段和外部内容当数据而非规则 |

## 阅读边界与限制

- 本轮未运行两个外部仓库、未安装依赖、未验证其线上产品行为。
- Pi 的编码 agent 和 DeepSeek Harness 的通用运行时并非医疗系统；它们不能证明医学回答的准确性、临床安全性或合规性。
- 外部源码当前快照可能继续变化；后续引用必须带快照或重新核对行号。
- `resources/clones/` 是可重建材料，真正不可重建的是本文件及 [decision.md](decision.md) 中的项目取舍。
