# 来源登记 · 模型、开源项目与实验路线

## 自有积累

| 来源 | 位置 | 当前结论 |
| --- | --- | --- |
| 提示词消融 | `docs/experiments/006_system-prompt-ablation.md` | 提示词保持回答性，但不能稳定限制具体医学补全 |
| 上下文 × 三模型 | `docs/experiments/008_context-model-factorial.md` | 患者知识选择明显优于专业原文；三个 Flash 候选仍未过高风险校准 |
| V4 Pro 筛选 | `docs/experiments/009_model-replacement-screen.md` | 更强模型仍有 4/10 明确 U/S 失败，单独换模型不放行 |
| 当前运行时 | `src/infrastructure/deepseek-model-adapter.ts:229` | 固定 `deepseek-chat`，未来接入任何新模型前必须改成受控配置 |

## GitHub 与官方实现

| 项目 | 协议/时效 | 可借什么 | 本轮判断 |
| --- | --- | --- | --- |
| [promptfoo/promptfoo](https://github.com/promptfoo/promptfoo) | MIT；浅克隆 `127d905`，2026-08-20 | 本地模型矩阵、JS 自定义断言、LLM rubric、CI、红队 | **保留参考**；本轮现有 runner 已够用，不增加产品或开发依赖 |
| [shibing624/MedicalGPT](https://github.com/shibing624/MedicalGPT) | Apache-2.0；浅克隆 `ccc05f4`，2026-06-02 | Qwen3.5 的 SFT、DPO、工具调用训练、数据校验 | **不采用**；训练不在报价范围 |
| [amazon-science/RAGChecker](https://github.com/amazon-science/RAGChecker) | Apache-2.0；浅克隆 `6091f08`，2024-12-13 | claim recall、context precision、faithfulness、hallucination 分层 | **借指标结构**；现成裁判仍可能误判中文医学行为 |
| [openai/simple-evals HealthBench](https://github.com/openai/simple-evals/blob/main/healthbench_eval.py) | MIT；仓库已声明不再新增评测 | rubric-based 健康对话评测参考实现 | **只借评分方法**，不直接拿英文题替代项目黄金集 |
| [AI4LIFE-GROUP/med-safety-bench](https://github.com/AI4LIFE-GROUP/med-safety-bench) | MIT；数据声明仅研究用途 | 训练/测试拆分、攻击样本与安全示范 | **只借数据设计**；不混入患者生产数据或直接训练上线 |
| [FreedomIntelligence/CMB](https://github.com/FreedomIntelligence/CMB) | Apache-2.0；2025-03-27 | 中文医学考试与 74 例复杂问诊评测 | **只作能力旁证**；考试/诊断任务不等于患者科普边界 |
| [gzxiong/MedRAG](https://github.com/gzxiong/MedRAG) | 仓库为 NCBI public-domain notice；2025-05-08 | corpus/retriever/LLM 分层和迭代检索 | **只借架构**；英文医学语料与本项目 truth 角色不同 |
| [Institute4FutureHealth/CHA](https://github.com/Institute4FutureHealth/CHA) | MIT；2025-11-05 | planner、task、memory、response generator 分层 | **不接运行时**；与 Pi/DSH 一样只作组织参考 |
| [FreedomIntelligence/HuatuoGPT-o1](https://github.com/FreedomIntelligence/HuatuoGPT-o1) | 仓库根目录未提供 LICENSE | 中文/英文医疗推理模型、SFT 数据、verifier 思路 | **暂不直接复用**，先解决权重和数据许可证及患者任务适配 |
| [langfuse/langfuse](https://github.com/langfuse/langfuse) | MIT，`ee/` 除外；持续维护 | trace、数据集、人工标签、线上反馈 | **生产后再引入**，当前先用本地文件避免运维过重 |

三个仓库已浅克隆到 `resources/{promptfoo,MedicalGPT,RAGChecker}`，只保留为只读研究快照，
不复制源码进入作品区，也不成为本轮依赖。
