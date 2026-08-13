# 现实约束 · kangmin

> 陈述句：给谁用、日程、底线红线、手上资源。约束变了就改这里，别处只放指针。

- 创建：2026-08-13

## 给谁用

- 患者：过敏性鼻炎患者（含青少年/成人、轻症/重症）——内容必须通俗科普语言，
  患者可懂可执行。
- 运营人员：内容（文章/视频/知识库/站内消息）与用户管理。

## 交付形态与现状

- CLI-first：核心能力先沉淀为命令与应用服务，再由 HTTP 接口承载；微信小程序为薄壳
  （待接入）。
- 线上：客户试用环境 `https://49.232.26.48` 运行中（release `e87151d`）；正式切换
  待资源，见 `docs/plan/008_tencent-cloud-production-cutover.md`。

## 范围与报价红线

- 报价 2,800 元 / 15 个工作日（`vault/truth/抗敏先锋AI小程序报价表.md` 为最高依据；
  小程序 2,150 元、管理后台 650 元）。
- 报价外能力（向量库、embedding、新模型、未列功能）一律先作者拍板，不默认开工。

## 模型与智能体现状

- 模型已拍板（2026-08-13）：通义千问，且具备图像识别能力（可用于手册穴位图等
  图片内容识别）；现网 DeepSeek 仍服务已上线的 knowledge-qa，生成链路按千问适配。
- 智能体是患者科普问答型，不是写码型（见
  `state/memory/20260813-agent-lens-patient-qa.md`）。

## 底线红线

1. 医学安全：证型判定与诊疗框架由后台知识库唯一管控；AI 不自行推理、不脱离给定
   穴位/疗法新增方案。
2. 健康数据隐私：OpenID/session_key/AppSecret 不落库、不进日志、不入仓；试用患者
   数据不默认带进生产。
3. 真相源保密：`vault/` 被 Git 忽略，未经授权不公开、不提交客户资料。
4. Git 无人值守边界：不自动合并发版；破坏性/依赖口味/对外的活登记 follow-up 待作者
   在场。

## 节奏与流程

- 轮次制：每轮倒序追加 `state/board.md`；commit 中文祈使句 + `Change-By`/`Agent`/
  `Model` trailer。
- worktree 并行 ≤ 4；派活前先 fetch；忽略区不进 worktree。
- 单次回复 ≤ 400 token；长内容按寿命分流（`_work/` / board / memory / docs）。

## 在手资源

- 微信小程序 AppID `wxec3aeaadcddaf45e`（AppSecret 只经服务器密钥配置注入）。
- 腾讯云 CVM（ap-beijing-6）；托管 PostgreSQL/COS 待联调；微信开发者工具已登录。
- Node v24.18.0、npm 11.16.0；truth 五份现行 Markdown；报价 .xlsx 原件归档于
  `_archive/20260811-quotation-original/`。
- 参考仓：本地 `~/Documents/cc/demo01_mini_cc`（极简 CC）；opencode/pi 待拍板后浅克隆
  进 `resources/clones/`。
