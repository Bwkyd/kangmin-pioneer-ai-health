# 两类来源 · 医疗 RAG 命中失败、模型越界与答案发布门的近期业界实践

> 2026-08-22。按**谁积累的**分尽：自己积累的、别人积累的。
> **两类进来都问同一句：它今天还算数吗？**
>
> ⚠️ 「都没有所以自己跑」不在这里——**那不是来源，是做法**，见 `gap.md` 的「它们没做的」。
>
> ⚠️ 下面的市场与站点**会变**，用前核一眼；名字对不上就搜同类。**方法不变，名单会老。**

---

## 一、自有积累 —— 可照搬，先确认权利与时效

自家旧项目、老代码、团队规约、你自己写过的东西。

### 怎么查

**先跑一把**：`bash skills/aias-meta-research/scripts/scan-own.sh "<关键词>"`
——一次扫完本机项目、提交历史、过往对话记录，按最后改动时间排。

| 去哪 | 怎么翻 |
|---|---|
| **过去的项目目录** | 直接看。做过类似的事没有？哪一版跑通过？ |
| **自己的提交历史** | `git log --oneline --all` · `git log --author=<你>` ——**代码记做成什么样，提交记当时为什么这么定** |
| **过往对话记录** | 记忆和现实对不上时，去翻当时的讨论——**文档说 A、代码做了 B、你记得是 C，谁都别直接信** |
| **团队的仓库与规约** | 别人踩过的坑，规约里往往留着痕迹 |
| **自己写过的文档** | 笔记、总结、发过的文章 |

### 登记

| 是什么 | 在哪 | 还算数吗 | 判据 |
|---|---|---|---|
| 患者智能体边界与真实基线 | `.42cog/intent.md`、`AGENTS.md`、`docs/experiments/014_patient-agent-evaluation-baseline.md` | 算 | 当前方向与 2026-08-22 隔离真实模型回放 |
| 既有架构调研与实验 | `docs/research/008_model-safety-boundary/`、`009_answer-first-medical-agent/`、`010_eval-driven-context-engineering/` | 算，但结论按新基线收窄 | 已证明提示词、同模型审阅和整段关键词门各自的边界 |
| 当前评测实现 | `src/evals/knowledge-qa/`、`src/tests/agent-evaluation-grader.test.ts` | 算 | 已把路由、检索、模型原文、发布正文和持久化分开记录 |

⚠️ **不自动可信**。同是自家的东西，判决可能相反：
「这个规约可能过时了，可以参考，但不能完全从它出发」vs「这个我反复测试过、生产跑通了，尽量复用」。

⚠️ **你三个月前写的东西，和陌生人写的东西，享受同一套审查。区别只在于——你有权照搬它。**

---

## 二、他人积累 —— 只读借鉴，先查协议

### 查四类，用同一套方法

**换对象，方法不变**——都是同一个决策点、同一套派活四件事（见 `assign.md`）。

| 查什么 | 查什么问题 | 去哪查 |
|---|---|---|
| **技能生态** | 这件事有没有人做成过技能？ | 各家插件市场与技能仓库；搜 `awesome-<你的领域>` 一类的清单仓 |
| **命令行工具** | 有哪些硬工具，用哪个？ | 三大分发市场：**Homebrew**（Mac）· **npm**（JS，四百万包）· **PyPI**（Python，八十多万项目）。Windows 看 **Scoop** / **winget** |
| **模型** | 这个活该用哪个模型？ | 公开评测榜单与各家技术报告。**要多模态、要长上下文，就得专门看那一栏** |
| **别人的项目** | 源码 · 提交历史 · 放弃过什么 | 代码托管平台（GitHub / GitLab / 国内平台）。**浅克隆到参考区再读**，别在网页上翻 |

**取材**：`bash skills/aias-meta-research/scripts/clone.sh <url>`（要挖提交历史加 `-d 200`）

### 查模型这一栏，多问三句

榜单也是他人积累，**同样要判时效、判来路**：

- **谁做的榜**？做榜的人和被测的模型有没有利害关系？
- **什么时候的**？半年前的榜单在这个行当里基本等于过期。
- **测的是不是你要的那件事**？综合分高，不代表你这一类任务上强。

**最后一句最要紧**：能自己拿三五个真实任务试一遍，胜过读十份榜单。

### 登记

| 是什么 | 在哪 | 协议 | 角色 | 读多深 | 还活着吗 |
|---|---|---|---|---|---|
| Google Check Grounding | <https://docs.cloud.google.com/generative-ai-app-builder/docs/check-grounding> | 官方文档，只读引用 | 零件 | 逐项核对输出 | 2026-08-22 回读；常规输出含声明与引用，claim-level score 文档仍列为实验能力 |
| Azure Groundedness Detection | <https://learn.microsoft.com/en-us/azure/ai-services/content-safety/quickstart-groundedness> | 官方文档，只读引用 | 备选零件 | 只读能力与限制 | 2026-02-26 更新；仍为 preview，概览注明 groundedness 模型仅英文 |
| AWS Bedrock Contextual Grounding | <https://docs.aws.amazon.com/bedrock/latest/userguide/guardrails-contextual-grounding-check.html> | 官方文档，只读引用 | 反例与备选零件 | 逐项核对限制 | 2026-08-22 回读；明确不支持 conversational QA/chatbot |
| NVIDIA NeMo Guardrails | <https://docs.nvidia.com/nemo/guardrails/latest/configure-guardrails/guardrail-catalog/fact-checking> | Apache 2.0；本轮只读 | 要学的 | 只读分层架构 | 2026-08-22 回读；支持按需输出 rail，也明确自检依赖模型能力 |
| CRAG 与 RAGChecker | <https://arxiv.org/abs/2401.15884>、<https://arxiv.org/abs/2408.08067> | 论文只读引用 | 要学的 | 读方法与限制 | 2024 论文；分别处理检索纠错与检索/生成细粒度诊断 |
| OpenAI HealthBench | <https://openai.com/index/healthbench/> | 官方发布与论文，只读引用 | 评测范本 | 读任务与 rubric | 2025-05；5,000 个真实感多轮对话、医生逐题 rubric |
| Google g-AMIE | <https://research.google/blog/enabling-physician-centered-oversight-for-amie/> | 官方研究说明，只读引用 | 医疗边界研究范本 | 读运行边界与监督 | 2025-08 虚拟 OSCE 研究；个体化建议不直接发患者，由医生审核，不冒充生产实践 |

⚠️ **读懂 → 自己写，绝不复制粘贴。** GPL / AGPL 只参考不链接。
⚠️ **协议不只回答「能不能用」，还决定「能读到哪一步」。**

---

## 两类都不算数时

那不是失败，那是**下一步的入口**：确认了没有，才该去跑实验。
接着填 `gap.md` 的「它们没做的」——**「压根没有」是查完之后的结果，不是时间判断。**

## 最后

**读，是复用别人的；跑，是长出你自己的。** 这一份只管前半——材料从哪来；
后半在 `gap.md` 与 `decision.md`。
