# 派活模板 · 开源候选统一核查

对每个候选只回答以下问题，800 字以内，必须带 `file:line`：

1. 能否在不替换当前 Agent 运行时的情况下独立接入？
2. 能否复现“模型 × 上下文 × 题集 × 多次试次”，并保存完整轨迹？
3. 自动评分是否支持代码判据、人工标签和裁判模型分开记录？
4. 若涉及训练，是否支持 Qwen、LoRA、SFT/DPO、工具调用和 JSONL 校验？
5. 患者数据是否可全部留在本地？许可证和额外基础设施是什么？

输出必须从“直接用 / 改造 / 只借方法 / 不适合”四选一，并列一个最强限制。找不到就写
“没有”，不得用 README 的宽泛宣传代替源码事实。

本轮源码抽查位置：

- Promptfoo：`resources/promptfoo/site/docs/getting-started.md:273-389`；
- MedicalGPT：`resources/MedicalGPT/README.md:161-273`、`scripts/run_sft.sh`、`scripts/run_dpo.sh`；
- RAGChecker：`resources/RAGChecker/ragchecker/computation.py:48-177`。
