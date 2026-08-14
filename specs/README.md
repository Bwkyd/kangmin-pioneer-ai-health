# specs：产出标准

> 本目录管「产出该长什么样」——文档、提交、代码、患者可见文本的标准。
> 分工线（不许串门）：
> - `.42cog/` 全是陈述句——这个系统是什么样；
> - `AGENTS.md` 是 Codex 主规约，`CLAUDE.md` 是同步兼容副本——你该怎么干；
> - `specs/` 是标准——产出该长什么样；
> - `vault/` 管「事实是什么」（truth 医学资料、style 品牌事实），不解决「应该是什么」。

## 索引

- [`style/`](style/) 产出风格标准：文档、提交、代码、患者可见文本该怎么写；
  品牌事实（Logo/颜色/字体/语气）仍在 `vault/style/`。
- 命名规约：`meta/kangmin_directory-protocol.md` 命名规约汇总（编号、kebab、日期制）。
- 验证入口：`python3 scripts/structure-lint.py .`；`cd src && npm run check`。

## 三种命名法

名字按以后如何检索来定，详细例外以 `meta/kangmin_directory-protocol.md` 为唯一正本：

| 命名法 | 用于 | 格式 |
| --- | --- | --- |
| 流水编号 | 计划、调研、评审、实验与变更档案 | `NNN_kebab-case.md`，永不重排或复用 |
| 创建日期 | `_work/`、`_archive/` 等过程目录 | `YYYYMMDD-slug/` |
| 最后更新日期 | 自动加载的项目记忆 | `YYYYMMDD-slug.md`，更新即改名并同步索引 |

被路径引用的规约文件不编号、不带日期，版本写在文件内部并由提交链保存历史。

## 最低格式

长期文档至少声明状态、日期、事实或代码基线、目标与非目标、证据、验证方式和限制；
患者可见内容必须符合 `style/README.md`，医学事实只能来自对应职责的 truth。
