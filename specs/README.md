# specs：产出标准

> 本目录管「产出该长什么样」——文档、提交、代码、患者可见文本的标准。
> 分工线（不许串门）：
> - `.42cog/` 全是陈述句——这个系统是什么样；
> - `CLAUDE.md` 全是祈使句——你该怎么干；
> - `specs/` 是标准——产出该长什么样；
> - `vault/` 管「事实是什么」（truth 医学资料、style 品牌事实），不解决「应该是什么」。

## 索引

- [`style/`](style/) 产出风格标准：文档、提交、代码、患者可见文本该怎么写；
  品牌事实（Logo/颜色/字体/语气）仍在 `vault/style/`。
- 命名规约：`meta/kangmin_directory-protocol.md` 命名规约汇总（编号、kebab、日期制）。
- 验证入口：`python3 scripts/structure-lint.py .`；`cd src && npm run check`。
