# 两类来源 · 医学输出拦截

> 2026-08-23。外部资料只读借鉴，不复制实现；公开产品能力会变化，正式采购前需重新核验。

## 自有积累

| 来源 | 当前证据 | 判断 |
|---|---|---|
| `docs/experiments/006_system-prompt-ablation.md` | 三组提示的高风险通过仅 2/8、2/8、3/8 | 系统提示是必要约束，但不能单独承担硬边界 |
| `docs/experiments/005_answer-first-verify-repair.md` | 同模型复核漏掉 2/2 已知 P1，并增加显著延迟 | 不做全量“生成模型再审生成模型” |
| `docs/experiments/017_system-prompt-minimal-safety-gate.md` | 隔离候选中前置分流 15/15、输出门 20/20、真实低风险 18/18，p95 2.37 秒 | “模型前分流 + 提示 + 最小输出兜底”值得继续，但仍只是有限题集，不是生产证明 |
| `resources/promptfoo`、`resources/RAGChecker` | 前者是红队/评测，后者是离线 claim 级 RAG 诊断 | 可用于造题和验收，不是运行时医学裁判 |
| `resources/MedicalGPT` | 以 SFT/RLHF/DPO 等训练为主 | 当前无训练数据、GPU和范围授权，不直接采用 |

## GitHub 浅克隆

| 项目 | 快照 | 协议/限制 | 角色与结论 |
|---|---|---|---|
| Meta PurpleLlama | `resources/PurpleLlama@4be64c3a` | 根目录 Llama 社区许可，组件各自许可 | **要比的**。Llama Guard 4 是 12B 输入/输出分类 LLM；S6 覆盖专业建议，但类别过宽，官方多语言评测不含中文，不能直接作本项目医学裁判 |
| NVIDIA NeMo Guardrails | `resources/NeMo-Guardrails@e961f810` | Apache-2.0 | **要学的**。它是护栏编排框架，可接 Nemotron/Llama Guard/ShieldGemma；并不自带一个懂本项目 truth 的万能判断器 |
| XMUDM MedGuard | `resources/MedGuard@4f2778d` | README 声称 MIT，但快照缺根 `LICENSE`，集成前须澄清 | **只借鉴架构**。以原子医学声明、16,535 条疾病与 187,738 条药物知识、检索和强化学习审查远程诊疗，远重于本项目 |
| MedSafetyBench | `resources/med-safety-bench@dc5d88e` | MIT；数据明确限研究用途 | **评测零件**。含 1,800 组安全示范和 74,374 条有害请求，是 benchmark/训练材料，不是在线拦截器 |

关键源码证据：

- `resources/PurpleLlama/Llama-Guard4/12B/MODEL_CARD.md:5`、`:75`、`:113`、`:145`、`:174`、`:214`、`:220`：12B、专业建议类别、输入/输出过滤、评测与语言限制。
- `resources/NeMo-Guardrails/docs/configure-rails/guardrail-catalog/content-safety.mdx:11`、`:49`、`:63`、`:103`、`:120`：可插拔模型、双向 rail、策略提示与输出解析、推理 guard 的 token 成本。
- `resources/MedGuard/README.md:4`、`:6`、`:65`、`:96`：声明拆分、超大医学知识库、检索与训练管线。
- `resources/med-safety-bench/README.md:9`、`:15`、`:30`：用途、规模和实验性质。

## 模型厂商与论文

| 来源 | 一手事实 | 对本项目的含义 |
|---|---|---|
| [OpenAI gpt-oss-safeguard](https://openai.com/index/introducing-gpt-oss-safeguard/) | 提供 20B/120B 可带自定义策略的推理安全模型；官方同时描述“快速高召回分类器先筛，疑难再交安全推理器”的纵深防御 | 小分类器常见，但只是级联首层；策略频繁变化或样本少时才值得用推理 guard，代价更高 |
| [Anthropic 下一代 Constitutional Classifiers](https://www.anthropic.com/research/next-generation-constitutional-classifiers) | 采用廉价探针筛全量、可疑流量再升级到更强分类器 | 支持“只审疑难项”；其内部激活探针依赖模型内部权重，不能原样套到千问 API |
| [Google Model Armor](https://cloud.google.com/security/products/model-armor) | 规则、机器学习与 AI reasoning 的 defense-in-depth，检查输入和输出 | 大厂也不是只押一个模型；通用有害内容、PII、提示注入与医学业务边界应分开 |
| [AWS Bedrock Guardrails](https://docs.aws.amazon.com/bedrock/latest/userguide/guardrails.html) | 内容过滤、拒绝主题、词表、PII、grounding、自动推理等多层能力，可分别检查输入和输出 | “关键词”仍有位置，但只适合精确名单/格式；语义主题由分类器处理，业务最终动作仍由应用决定 |
| [Google ShieldGemma](https://ai.google.dev/responsible/docs/safeguards/shieldgemma) | 2B/9B/27B 通用安全分类模型，主要政策为危险、仇恨、骚扰、色情，且公开文本版本以英语为主 | 即便叫“小模型”，也未必小到 CPU 轻服务可接受，更未覆盖中文鼻炎动作政策 |
| [CARES](https://arxiv.org/abs/2505.11413) | 医疗安全采用 Accept/Caution/Refuse；其所谓 lightweight classifier 实为微调 Qwen2.5-7B，用于识别越狱形态，再配提醒提示 | 说明医疗场景需要同时测漏拦和过度拒答；也证明“轻量”常是相对生成大模型而言 |
| [MedGuard 论文](https://www.nature.com/articles/s41746-026-03116-0) | 用原子声明、医学检索、分层分类与专业人员评估识别中文远程诊疗风险 | 最接近医学语义审查，但依赖大知识库、训练和专业定标，只能借鉴“抽取后核验” |

## 来源停止线

已覆盖三种大厂路线（通用审核、专用分类、推理 guard）、两个医疗体系和四个本地源码快照，足以回答是否直接上小模型。作者已据此取消小模型路线；再多列供应商不会改变“只评估无模型薄兜底”的取舍。
