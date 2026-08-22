# 007 · Pi 与 DeepSeek Harness 的边界，抗敏先锋的通用 Agent 应该怎么做

> 2026-08-21。四步走第二步：系统分析。**先读源码，再纠正设计。**

## 作者纠偏

前一版把“患者、公益团队、成人、儿童”写成了对话路由，这是错误的产品化方式，现已撤回。

抗敏先锋不应要求用户先选择身份或模式。大模型应根据当前话题、历史上下文和用户表达，自行判断是在描述症状、询问知识、追问已有结果、学习科普、寻求下一步，还是仅仅需要澄清；只有当歧义会影响安全时，才用自然语言追问。现有 `child/adult` 只能继续作为问卷规则产生的医学事实，不能变成聊天模式选择。

## 这次要决定的

不是“接入 Pi 还是 DeepSeek Harness”，而是：**怎样把当前几个僵硬的一次性模型调用，重组为一个有工作手册、能自己判断语境、能主动调用只读知识能力的连续 Agent。**

本轮源码只读覆盖四条链：

1. 稳定系统提示词与项目指令；
2. 每轮动态上下文与扩展钩子；
3. 工具/知识能力的声明、调用和结果边界；
4. 会话事件、请求快照、消息重建和一致性校验。

Pi 快照为 `5cd93f688aaab89dbb6dfa4aca535f21796ae185`，DeepSeek Harness 快照为 `47f943859bef60e4160492346772ded9b24f765a`。两个目录只读，未运行、未安装依赖、未复制代码或提示词。

## 本轮结论

真正应该借的是下面这个边界，而不是“更严格的路由”：

> **对话理解可以开放，医学权威不能开放；回答策略可以由模型判断，医学事实、批准证据和最终输出必须由系统守住。**

Pi 把项目指令稳定地放入上下文，技能按需读取，每轮允许扩展追加消息；[Pi 的 system prompt builder](../../../resources/clones/pi-mono/packages/coding-agent/src/core/system-prompt.ts:27) 没有要求用户选择任务模式。DeepSeek Harness 把静态 prompt sections、动态 runtime context、工具 schema 和会话重建分开；[它的 system-prompt 注册表](../../../resources/clones/deepseek-harness/packages/core/system-prompt/src/index.ts:41) 也没有把受众枚举当作产品入口。

对抗敏先锋的推荐形态是：

> 一个通用鼻健康 Agent + 一份稳定工作手册 + 一个只读知识搜索能力 + 当前会话/规则/方案的动态上下文 + 服务端最终校验。

这比当前“问卷解释器 + 方案追问器 + 独立知识问答页”的拼接更接近小荷 AI 医生值得欣赏的连续体验，也保留医学红线。

详细草案见 [workbook-draft.md](workbook-draft.md)，真正需要作者拍板的选择见 [decision.md](decision.md)，自编验收问法见 [assign.md](assign.md)。

## 当前评审结论（km-review）

- **患者体验 P1**：`knowledge-qa.ts` 在没有字面命中时直接返回固定拒答，用户的同义表达、追问和上下文都没有被 Agent 理解。
- **工程事实 P1**：模型调用被拆成 extraction、explanation、knowledge answer、plan dialogue 几个端口，没有统一的工作手册、运行时上下文和主动工具循环。
- **医学安全 P1**：独立知识问答把模型生成文本直接作为答案返回；它没有复用方案追问使用的 `validateGeneratedMedicalText` 这一类统一门禁，不能因为 prompt 写了限制就视为已校验。
- **医学安全 P2**：开放模型能力时不能同时开放诊断、方案变更、操作参数、疗效承诺或未批准穴位/疗法；这些仍必须 fail-closed。

本轮只修正研究结论和设计文档，未修改 `src/`、`vault/truth/` 或 raw 原件。
