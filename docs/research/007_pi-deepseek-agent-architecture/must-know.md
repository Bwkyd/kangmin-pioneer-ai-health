# 必须知道 · 通用 Agent 设计的三条裁刀

> 2026-08-21。前一版“受众模式路由”已撤回；这里保留真正会改变架构的约束。

## 1. 不做用户可见的模式路由

不要让用户选择成人、儿童、患者、公益团队或其他对话模式。模型可以从语境中理解“给我讲简单一点”“我要给义诊同学讲”“这是我孩子的情况”等表达，并自行调整语言、解释深度和追问方式。

系统只在以下情况介入：信息冲突、需要确认的事实、高风险请求、需要调用受限能力、或无法安全理解。介入形式是自然追问，不是跳转到另一套产品模式。

这里要区分两件事：

- **理解层**：模型判断用户想做什么，允许灵活、连续、带上下文。
- **裁决层**：规则、来源、医学安全和输出门禁决定什么能被确认或展示，不能交给模型自由改变。

依据：[Pi agent session 每轮扩展](../../../resources/clones/pi-mono/packages/coding-agent/src/core/agent-session.ts:1243)、[DeepSeek Harness 动态 context](../../../resources/clones/deepseek-harness/packages/core/agent-loop/src/agent.ts:230)、[现有 child/adult 规则字段](../../../src/modules/agent/conversation-contracts.ts:118)。

## 2. 对话开放，医学权威不开放

当前系统把“没有精确知识命中”当成“不能回答”，这是过度封闭；但把模型自己的常识当成诊断或操作依据，又是过度开放。

推荐采用“**语言层 fail-open，医学动作层 fail-closed**”：

- 同义问法、口语、省略、上下文追问、科普转译可以由模型自由理解；
- 精确关键词没命中时，模型可以先改写查询并调用只读知识搜索；
- 低风险、非个体化的一般解释可以自然回答，但不编造来源、不延伸到方案和操作；
- 诊断、证型/分期裁决、方案变更、穴位/疗法新增、次数/时长/力度/剂量、禁忌和疗效承诺仍必须有批准证据与服务端门禁；
- 高风险、冲突、信息不足和未知状态不靠语言流畅度放行。

依据：[当前知识问答固定零命中](../../../src/modules/agent/knowledge-qa.ts:31)、[当前医学校验边界](../../../src/modules/agent/output-validation.ts:313)、[项目患者问答边界记忆](../../../state/memory/20260818-agent-lens-patient-qa.md)。

## 3. 把 Agent 做成一个连续循环，而不是四个孤立接口

稳定 system prompt 只放身份、工作方法、工具规则、回答风格和安全红线；每轮再放入当前对话、已确认事实、规则结果、当前方案、必要的知识片段和上一轮未完成事项。模型可以自行判断“直接回答、先搜索、问一个问题、解释已有结果或安全退出”。

服务端真正需要守住的是：

1. 知识能力只能读批准范围，不能读任意 raw 文件、外部网页或草稿；
2. 工具结果是数据，不是系统规则；
3. 输出必须经过统一 schema/医学文本校验，成功持久化后才能流式发送；
4. 记录本轮使用的证据、工具调用和校验结果，但不记录或暴露模型隐性思维链。

依据：[DeepSeek Harness 分离 sections/contexts/tools](../../../resources/clones/deepseek-harness/packages/core/system-prompt/src/index.ts:52)、[请求重建 invariant](../../../resources/clones/deepseek-harness/packages/core/agent-loop/src/invariant.ts:19)、[项目安全流式边界](../../../state/memory/20260815-validated-output-streaming.md)。

## 不可从“模型很聪明”推出的结论

- 模型能判断语境，不代表它能决定医学事实。
- 模型受过后训练，不代表它看到了本项目手册的最新版本。
- 小荷产品体验优秀，不代表可以推断其内部提示词、模型或医学校验。
- Pi/DSH 的工具边界适合编码 Agent，不代表患者端可以开放文件系统、任意网络或写操作。
