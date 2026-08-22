# 差距表 · 从僵硬问答到通用 Agent

> 2026-08-21。这里比较的是运行时边界，不是比较“哪个模型更聪明”。

| 设计层 | Pi 的做法 | DeepSeek Harness 的做法 | 抗敏先锋当前状态 | 结论 |
|---|---|---|---|---|
| 稳定工作手册 | 项目指令进入 system prompt，技能只先暴露元数据 | sections/persona 按顺序组装 | 只有分散在几个模型 prompt 和代码注释里的职责 | **补一份统一工作手册** |
| 语境理解 | 每轮可追加消息、扩展可改本轮上下文 | 每轮 assemble 动态 context，带来源快照 | extraction、knowledge、plan dialogue 各自调用，缺少统一上下文 | **重组为一个 Agent loop** |
| 用户任务判断 | coding agent 自己判断何时读技能/文件 | agent 通过 context、tools、waterfall 自主推进 | `shouldRetrieveApprovedKnowledge` 只在点名当前方案穴位时触发 | **让模型判断任务，服务端限制能力** |
| 知识访问 | 技能/文件按需读取 | tool provider/context 按作用域提供 | 字面子串命中；无命中固定拒答 | **改为模型可调用的只读搜索，后端做来源过滤** |
| 工具边界 | coding 工具由 harness 提供 | schema、顺序、作用域、执行结果分离 | 知识问答没有统一工具/证据协议 | **只引入一个只读知识工具，不引入文件/网络/写工具** |
| 输出与重建 | agent loop 统一 context/messages/tools | request/header、session event、invariant 保证请求可重建 | 方案追问有医学校验；独立知识问答直接返回生成文本 | **统一输出 envelope、校验、持久化和流式** |
| 对话模式 | 不要求用户选择成人/儿童/患者/培训模式 | scope 是运行时作用域，不是用户身份问卷 | 前一版误把受众做成产品路由 | **删除模式路由；保留模型语境理解** |

## 当前真正的 P1 缺口

1. [knowledge-qa.ts:31-44](../../../src/modules/agent/knowledge-qa.ts:31) 把字面检索零命中直接变成固定拒答，命中后把模型文本或片段直接返回。
2. [sqlite-knowledge-retrieval.ts:4-23](../../../src/infrastructure/sqlite-knowledge-retrieval.ts:4) 只有 query 和 2 字符片段 `LIKE`，没有语义改写、来源用途过滤或证据排序。
3. [conversation-service.ts:742-805](../../../src/modules/agent/conversation-service.ts:742) 的知识调用挂在规则方案追问后，触发面被当前方案与穴位条件卡住。
4. [knowledge-qa.ts:40-44](../../../src/modules/agent/knowledge-qa.ts:40) 没有明确复用 [validateGeneratedMedicalText](../../../src/modules/agent/output-validation.ts:317) 这类统一医学校验；模型 prompt 不是服务端门禁。

## 需要保留的硬边界

硬边界不应该表现为用户模式，而应该表现为能力权限：

- 可读：当前会话、已确认事实、已确认规则结果、批准知识搜索结果；
- 不可由模型裁决：证型、分期、方案、穴位清单、疗程、禁忌、操作参数、疗效；
- 不可调用：任意文件、外部网页、写数据库、发消息、执行命令；
- 必须记录：本轮工具调用、证据 ID/版本、输出校验结果和最终保存版本。

## 外部框架不解决的部分

Pi 与 DeepSeek Harness 能解决 prompt、context、tool 和 session 的组织，却没有抗敏先锋的医学 truth、规则包和患者风险分级。小荷 AI 医生能作为优秀产品体验参考，但没有公开内部代码、提示词和医学安全链，不能被当作实现说明。
