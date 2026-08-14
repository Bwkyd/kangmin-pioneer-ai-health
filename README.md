# 抗敏先锋 AI 鼻健康管理系统

> 这是一个面向过敏性鼻炎患者的 AI 鼻健康管理系统。作者确定方向、范围与医学边界，
> 系统围绕患者小程序和运营管理后台完成可验证交付。
>
> 作品在 `src/`；系统唯一收敛方向见 `.42cog/intent.md`，不要在本文件复制第二份。

## 从这里开始

作者首先确认 `.42cog/intent.md` 的“收敛方向”。范围、所属端、价格和工期以
`vault/truth/抗敏先锋AI小程序报价表.md` 为最高依据；题面、证型与期别、调理方法、
视频内容分别由 truth 中对应专项文件裁决。

AI 或开发者开始工作时读取 `AGENTS.md`；每轮实际状态、验证和下一步读取
`state/board.md`；当前实现的命令、配置和运行方式读取 `src/README.md`。

只读检查本机是否具备常用工具：

```bash
bash scripts/check-tools.sh
bash scripts/check-tools.sh --mirrors
```

脚本只报告，不安装任何软件。

## 项目产出

- 患者端：微信小程序最终形态，以及当前用于试用和验收的患者 Web、CLI 与 HTTP 接口。
- 管理端：维护文章、视频、内容推送与智能体知识资料的管理后台及对应 CLI、HTTP 接口。
- 核心闭环：可信科普与问答、安全问卷与规则判定、调理建议与受约束追问、症状记录与
  趋势回看。

大模型不负责证型、分期或调理方案判定；确定性规则与医学内容只服从对应职责的 truth。
系统提供科普与居家辅助调理建议，不替代专业医疗诊断，也不承诺疗效。

## 本地运行

主要开发环境为 macOS，Node.js 版本由 `.nvmrc` 固定。首次克隆后：

```bash
nvm use
bash scripts/install-git-hooks.sh
cd src
npm ci
npx playwright install chromium
npm run check
```

启动本地患者 Web 与 HTTP 服务：

```bash
cd src
KANGMIN_APP_ENV=local KANGMIN_ALLOW_DEV_SESSION=1 npm run start:http
```

默认访问 `http://127.0.0.1:8787`。开发会话不是生产认证；密钥、令牌、客户资料与真实
患者信息不得写入仓库、命令参数或日志。完整配置、错误码和降级行为见 `src/README.md`。

## 目录：六组

| 组 | 位置 | 职责 |
| --- | --- | --- |
| 开工手册与规约 | `AGENTS.md`、`CLAUDE.md`、`.42cog/`、`specs/`、`.codex/` | 方向、事实模型、工作纪律、产出标准与 Codex 项目设置 |
| 真相源与参考 | `vault/`、`notes/`、`resources/` | 项目裁决依据、作者私区与外部只读参考 |
| 脚本与扩展 | `skills/`、`.agents/skills/`、`.claude/workflows/`、`scripts/`、两份插件清单 | 可复用软能力、工具发现入口与确定性检查 |
| 作品 | `src/` | 当前主实现与最终交付 |
| 状态与文档 | `state/`、`docs/`、提交链 | 当前状态、记忆、计划、研究、评审与历史 |
| 过程材料 | `_build/`、`_work/`、`_archive/` | 可重建输出、一次性过程和快照，默认不入库 |

`legacy/` 是迁移前系统，只作需求、行为和验收参考，不向 `src/` 导入其业务实现。
`_work/` 是本项目对初始化模板 `_tmp/` 的明确本地化替代。完整目录语义见
`meta/kangmin_directory-protocol.md`。

## 四份系统陈述

| 文件 | 只负责回答 |
| --- | --- |
| `.42cog/intent.md` | 朝哪里使劲、真正难题、不做什么、作品怎样算合格 |
| `.42cog/real.md` | 当前日程、红线、资源和使用环境 |
| `.42cog/cog.md` | 核心实体、参与者及输入输出关系 |
| `.42cog/meta.md` | 系统身份、位置、交接和依赖 |

四份文件只写系统事实；AI 应该怎么工作以 `AGENTS.md` 为主、`CLAUDE.md` 为兼容副本；
产出应该长什么样写在 `specs/`。同一内容只保留一份正本，其余位置只放指针。

## 验证入口

```bash
python3 scripts/check-manifests.py
python3 scripts/structure-lint.py .
cd src && npm run check
```

文档或结构改动不必重复执行业务全量测试；代码变更按 `AGENTS.md` 中的影响范围选择
门禁。测试通过只证明候选改动满足相应检查，不代表客户验收、合并、部署或上线授权。

---

当前进展看 `state/board.md`。本 README 只作为给人的稳定入口，不承载每轮运行状态。
