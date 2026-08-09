# 受约束的灵活问诊 Agent 调研

- 状态：调研结论，供后续方案设计；未实施
- 日期：2026-08-09
- 代码基线：`4f1db14`
- 本地材料：`vault/raw/clinical/前置规则.md`、`vault/raw/product/页面展示.md`
- 目标：在不让模型改变客户规则、问题和方案结论的前提下，让按钮与自然语言进入同一套连续对话
- 非目标：本轮不修改业务代码、不改医学规则、不选择新的 Agent 框架、不部署

## 一、结论

本项目适合的不是“让大模型自由问诊”，也不是“在聊天窗口里嵌一个问卷”，而是一个**受约束的混合主动式对话 Agent**：

1. 客户材料编译成有版本、可追溯的题库、规则和输出模板；
2. 大模型只把自然语言转换为受控候选命令，不决定证型、期别或方案；
3. 患者确认后的结构化事实才进入确定性规则内核；
4. 对话策略专门处理澄清、纠正、跳过、插话后继续和无法确认；
5. 按钮只是回答同一条消息的快捷方式，与输入文字走同一语义入口。

这与 Rasa 的“LLM 负责生成受控命令、FlowPolicy 执行业务流程”思路最接近；Rasa 还把 correction、clarification、interruption、skip、cannot-handle 等作为独立的 conversation repair 模式，而不是寄希望于一个提示词自动处理全部情况。[Rasa Flows](https://rasa.com/docs/reference/primitives/flows/)、[Rasa Slots](https://rasa.com/docs/reference/primitives/slots/)、[Rasa Conversation Patterns](https://rasa.com/docs/reference/primitives/patterns/)

## 二、客户材料能保证什么，不能直接保证什么

### 2.1 必须保留的三个层次

| 层次 | 来源 | 运行时形态 | 模型权限 |
| --- | --- | --- | --- |
| 题库 | 《页面展示》Q1–Q14、补充安全题/筛选题 | 稳定 `questionId`、原题、允许选项、必答性、unknown 策略、来源引用 | 只能识别用户回答对应哪个已有选项，不得新增题目或选项 |
| 决策 | 《前置规则》及客户确认的冲突裁决 | 版本化纯规则/guard，输入仅为确认事实 | 无权修改条件、优先级和结果 |
| 呈现 | 《页面展示》急性期/缓解期模板 | 固定模板 + 已批准方案数据 | 只能生成不改变事实的衔接语；临床正文仍由模板输出 |

医疗问卷领域已有成熟的数据分离模式：HL7 FHIR `Questionnaire` 用稳定 `linkId`、`answerOption` 和 `enableWhen` 描述题目及显示条件，`QuestionnaireResponse` 单独保存回答；SDC 又扩展了自适应问卷与响应校验。项目不必完整引入 FHIR，但应借用“题定义与回答分离、稳定标识、条件可计算”的结构。[FHIR Questionnaire](https://hl7.org/fhir/R4/questionnaire.html)、[HL7 SDC](https://build.fhir.org/ig/HL7/sdc/)

### 2.2 两份 raw 材料存在字面冲突

《前置规则》开头说第二层依据 Q12–Q14，但后面的急性期/缓解期公式又使用 Q1–Q3；《页面展示》则把 Q12–Q14呈现为分层问题。技术架构可以保证每个已确认版本被忠实执行，却不能让两条互相矛盾的规则同时成立。

因此运行时不应直接读取 `vault/raw/`。`raw` 只保留来源；冲突经客户确认后进入 `vault/truth/` 或项目决策记录，再编译为带 `sourceRefs`、版本和哈希的可执行规则。当前作者代选的临时裁决仍需客户最终确认，灵活对话不能替代这一步。

## 三、成熟实现的共同模式

### 3.1 结构化槽位，而不是让模型控制业务流程

Rasa 把用户信息保存为 slots，并明确区分由 LLM/NLU 填充的槽位与由受控动作确定性填充的槽位；收集步骤支持校验、按钮、自定义追问及是否强制收集。[Rasa Slots](https://rasa.com/docs/reference/primitives/slots/)、[Rasa Flow Steps](https://rasa.com/docs/reference/primitives/flow-steps/)

Dialogflow CX 也将多轮 form filling 建模为一组必填参数，为每个参数定义初次提示、结构化值和失败后的 reprompt handler；意外输入不会天然等于重复原句，而可以改变提示或转移流程。[Dialogflow CX Parameters](https://docs.cloud.google.com/dialogflow/cx/docs/concept/parameter)

对本项目的启示：现有 `confirmed_answers` 方向正确，但还需把候选确认真正接通。每个事实应同时记录：

- `fieldCode/questionId`；
- 值：选项编码、yes/no/unknown 或受控 value；
- 状态：proposed / confirmed / rejected / superseded；
- 来源：button / exact_text / model_candidate / correction；
- 原始用户消息、规则包版本和确认时间。

只有 `confirmed` 才进入临床规则；`unknown` 是已确认的“不知道”，不是缺失，也不是 `no`。

### 3.2 对话修复是一等能力

成熟系统单独设计以下模式：[Rasa Conversation Patterns](https://rasa.com/docs/reference/primitives/patterns/)

- **clarification**：一句话可能对应多个选项时，先复述理解并让用户确认；
- **correction**：支持“我刚才说错了”，将旧事实标为 superseded，按新事实重算；
- **skip / unknown**：记录无法确认，换一种提示或给出可操作方法，然后推进其他可答项；
- **interruption**：用户问“为什么要问体温”时先解释，再回到原问题；
- **cannot handle**：明确说明没理解、请求改述，达到阈值后转人工/门诊，而不是无限重复；
- **cancel / resume**：暂停后恢复同一会话游标和待答问题。

LangGraph.js 的 interrupt/checkpoint 模式同样强调：待用户输入时必须保存可恢复状态，恢复要用同一 thread id，并把当前待答内容作为结构化 interrupt payload 返回。[LangGraph.js Interrupts](https://docs.langchain.com/oss/javascript/langgraph/interrupts)

### 3.3 确定性 guard 与模型理解分离

XState 将 guard 定义为纯、同步条件，事件只有在 guard 为真时才能走对应转换；多个 guard 按顺序求值并可提供默认分支。这与临床规则“输入确定事实 → 输出唯一结果”的要求一致。[XState](https://github.com/statelyai/xstate)、[XState Guards](https://stately.ai/docs/guards)

本项目已有临床内核、SQLite/PostgreSQL 会话持久化、revision CAS 和决策凭证，不建议为了采用框架而迁移到 Rasa、Dialogflow 或 LangGraph。应吸收其模式，在现有 TypeScript/CLI-first 架构内补齐缺失层。引入第二套流程运行时反而会制造两个会话游标和两个真相源。

## 四、建议架构

```text
用户点击或输入文字
        │
        ▼
统一 UserTurn（保存友好文本 + 语义事件）
        │
        ├─ 当前题精确匹配/按钮 ──────────────┐
        │                                     │
        └─ 模型受控提取 → Candidate[] → 确认 ┤
                                              ▼
                                    Confirmed Fact Ledger
                                              │
                                              ▼
                              确定性临床规则内核（唯一裁决者）
                                              │
                                              ▼
                         Dialogue Policy（澄清/纠正/插话/unknown）
                                              │
                                              ▼
                  单一 AssistantTurn（正文 + 同消息选项 + 状态）
```

### 4.1 统一输入语义

按钮和文字不能再走两条业务路径：

- 点击“否”产生 `{questionId, optionCode, source: "button"}`；
- 输入“没有超过 39℃，也没寒战”经过精确解析或模型提取，产生相同 option candidate；
- 当前问题的明确单一回答可直接确认，并显示“已记录：否 · 可修改”；
- 模型从长句中提取的多项信息先批量展示“我理解为……”，患者确认后一次进入规则；
- 模糊、冲突或跨字段推断不得自动确认。

疑似高危内容应先显示固定就医提示，不等待模型确认后才提醒；正式决策凭证仍区分“疑似候选”和“患者确认”。

### 4.2 单一输出契约

建议由服务端返回并持久化同一份患者可见 turn，而不是正文、`nextQuestions` 和前端卡片各自拼装：

```ts
interface AssistantTurn {
  text: string;
  acknowledgement?: { questionId: string; displayValue: string };
  pendingQuestion?: {
    questionId: string;
    prompt: string;
    options: Array<{ code: string; label: string }>;
  };
  repair?: "clarify" | "correct" | "resume" | "cannot_handle";
}

interface UserTurn {
  displayText: string;
  answer?: { questionId: string; optionCode: string; source: "button" | "text" };
  rawText: string;
}
```

选项直接属于对应的助手消息；点击后控件冻结并显示已选项，不再在消息流末尾悬挂一个独立问卷。历史恢复读取 `displayText` 与语义字段，不能展示 `high_fever=unknown`、`q1=B` 等内部载荷。

### 4.3 灵活性边界

| 场景 | 应有行为 | 决策树是否变化 |
| --- | --- | --- |
| “没有发烧” | 理解为当前题“否”，自然确认并问下一题 | 不变 |
| “不清楚，家里没有体温计” | 记录 unknown，给出固定说明，继续其他安全项；最终必要信息仍缺则 fail-closed | 不变 |
| 一句话回答三项 | 提取 3 个候选，批量确认后写入 | 不变 |
| “刚才手脚凉说错了” | 展示原值→新值确认，版本化覆盖并重算 | 规则不变，输入版本变化 |
| “为什么问这个？” | 回答固定目的说明，再恢复原待答题 | 不变 |
| 问与鼻健康无关的问题 | 简短说明范围并恢复评估 | 不变 |
| 模型输出不存在的字段/选项 | Schema 拒绝，进入 clarification/cannot-handle | 不变 |

所谓“灵活”应体现在理解、衔接、纠错和恢复上，而不是允许模型改客户规则。

## 五、现状差距

仓库原设计 `docs/plan/004_kangmin-patient-cli-design.md` 已明确“模型提取待确认候选，患者可确认、修改、忽略或回答不知道”，方向正确；当前主要是实现未闭环：

1. `ConversationService` 已保存 proposed candidates，但没有采用/忽略/修改的应用服务入口；
2. Web 的 `AgentTurnResult` 不接 `proposedCandidates`，没有候选确认 UI；
3. 助手正文与选项卡分别渲染，按钮不属于具体消息；
4. 服务端存协议载荷，前端只做瞬时友好气泡，刷新后语义展示丢失；
5. `unknown` 的有效补问状态在正文、API 和持久化之间不一致，形成重复题；
6. 没有 correction、clarification、interruption、cannot-handle 等对话修复状态；
7. 模型提示允许从全部 `FIELD_LABELS` 提取，而不是严格限制到当前允许收集/可纠正字段，权限仍可进一步收窄。

因此无需推倒临床内核，重点是把已经设计但未实现的“候选→确认→事实”桥接起来，并把对话修复建成显式状态。

## 六、建议实施顺序

### P0：先把“同一轮问答”做对

- 修复 unknown 后下一题推进与即时/刷新一致性；
- 建立统一 `AssistantTurn/UserTurn`；
- 选项嵌入对应助手消息；
- 持久化友好展示值与语义载荷；
- 按钮与等价短文本做同态测试：输入来源不同，确认事实和规则结果必须相同。

### P1：接通真正的自然语言确认

- 限定模型只看当前待答题、允许选项、已确认事实和可纠正字段；
- 实现 candidate adopt / modify / ignore；
- 明确短答自动确认、长句批量确认和高风险疑似先提示策略；
- 实现 correction、clarification、unknown、interruption、resume、cannot-handle。

### P2：规则资料产品化

- 将题库、规则、输出模板拆成版本化 schema，并为每项保存 `sourceRefs`；
- 客户确认 raw 冲突后更新 truth，再编译发布；
- 增加规则组合穷举、来源覆盖、模型越权、对话修复和多轮恢复测试；
- 管理端能看到“原话→候选→确认事实→规则输入→决策凭证”的完整审计链。

## 七、验收场景

至少覆盖以下端到端场景：

1. 同一问题点击“否”和输入“没有”得到完全相同的确认事实、下一题和最终结果；
2. 点击“不清楚”不重复原题，刷新后仍显示相同下一题；
3. 用户一句话回答多个问题，系统先汇总确认，不静默采用；
4. 用户纠正上一题后旧事实失效，规则结果重新计算；
5. 用户中途问“为什么”，回答后能回到原流程；
6. 模型不可用时按钮和精确文本路径仍能走完整决策树；
7. 模型伪造字段、选项、证型或方案时全部被拒绝；
8. 疑似高危输入立即出现固定安全提示，unknown 永不当作 no；
9. 实时界面、刷新恢复、历史切换三者的消息与控件完全一致；
10. Q1–Q14 原题原选项、规则版本、输出模板均可回溯到客户确认来源。

## 八、限制

- Rasa 的部分 CALM 能力属于 Rasa Pro，本调研只借鉴架构模式，不建议直接引入其运行时。
- Dialogflow CX 是托管平台；LangGraph.js/XState 是通用编排工具，均不能替代本项目的临床规则审核和来源治理。
- FHIR/SDC 提供问卷结构参考，但项目是否声明标准兼容需要另行做完整一致性评估。
- 自然语言等价样本、unknown 处理文案和高风险疑似策略仍需产品与医学共同验收。
- NIST AI RMF 强调持续治理、测量和人类监督；它是风险管理框架，不是本项目的具体临床合规认证。[NIST AI RMF](https://www.nist.gov/itl/ai-risk-management-framework)
