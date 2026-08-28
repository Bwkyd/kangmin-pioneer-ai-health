# 小程序逐页 E2E 回归检查点

- 状态：已完成（源码级门禁与真实微信开发者工具复测均通过）
- 日期：2026-08-28
- 范围基线：`main@56044fc` → 候选分支 `codex/miniprogram-e2e-regressions`
- 对应实验：[040 小程序 E2E 缺陷回归检查点](../experiments/040_miniprogram-e2e-regression-checks.md)
- 对应 Issue：[#378](https://github.com/Bwkyd/kangmin-pioneer-ai-health/issues/378)、[#379](https://github.com/Bwkyd/kangmin-pioneer-ai-health/issues/379)、[#380](https://github.com/Bwkyd/kangmin-pioneer-ai-health/issues/380)

## 目标

在已有基础壳和症状管理冒烟之上，保留一个能在修复前明确报红、修复后可重复放行的小程序逐页
回归入口，并用真实微信开发者工具测量页面几何，避免“Node 壳测试全绿”被误读为微信页面已
验收。

## 非目标

不修改患者业务代码中的医学规则、truth、服务端接口、微信后台合法域名或真实患者数据；不把
本机自动化工具写入生产依赖；不把源码门禁、模拟器截图或匿名体验数据扩大为真机验收、客户验收、
生产就绪或医学批准。为关闭已登记缺陷，允许修改小程序安全降级、页面行为和 WXSS。

## 检查入口与范围

```bash
cd src && npm run test:smoke:miniprogram
```

入口逐项检查：

| 编号 | 检查 | 证据层级 |
| --- | --- | --- |
| #378/API | 网络能力开启时使用 HTTPS 域名，不使用 IPv4 地址；没有合法域名时显式关闭网络并不调用 `wx.request` | 源码 + 请求层行为门禁 |
| #378/文案 | 问助手、学一学不直接展示微信 `request:fail` 等运行时错误 | 公共错误转换门禁 |
| #379/结构 | 记录行存在换行、收缩、媒体规则或等价 grid/flex 窄屏兜底 | WXSS 结构门禁 |
| #380/行为 | 我的页所有带箭头入口都有 tap/catch 行为，处理函数由清单门禁确认 | WXML + JS 静态门禁 |

健康档案真实像素、实际换行和点击反馈继续按实验 040 的 390px 微信开发者工具检查点复核；
源码门禁不能代替这一步。真实复测使用匿名本地 fixture，不上传服务端。

## 依赖与风险

- 依赖现有 `npm run build`，避免对过期 `dist/` 做判断。
- #378–#380 已修复；入口非零仍表示回归失败，不加入“已知失败白名单”。
- 客户合法域名是否已在微信后台登记、证书和真机网络是否可用，只能由作者在正式微信环境确认；
  本候选默认安全降级，不伪装线上内容已可用。
- 本机未配置的 PostgreSQL、S3/MinIO 契约仍按既有门禁报告为跳过，不由本入口覆盖。

## 验收与收尾证据

完成本项检查点建设的最低条件：

1. 入口每项带 Issue 编号并单独输出；任一失败、源码结构变化或配置回退都退出非 0。
2. 修复前基线稳定捕获 4/4 个已知回归点，修复后 4/4 通过。
3. 既有 `test:smoke:shell`、`test:smoke:record`、普通 `check-miniprogram` 不因新增入口改变其原有口径。
4. 真实 DevTools 复核仍保留截图要求，且只使用模拟或匿名数据。

本轮实测：修复前 `test:smoke:miniprogram` 按预期 exit 1 并逐项拦截 4/4 个已知问题；修复后
同一入口 4/4 通过。新增 `src/tests/miniprogram-regression.test.ts` 承载 6 条回归用例，原
综合测试文件保持在既有行数基线内。既有 `test:smoke:shell` 6/6、`test:smoke:record` 3/3、
普通 `check-miniprogram` 通过。完整 `cd src && npm run check` 通过：442 条 Node 测试中
364 条通过、78 条因本机未配置 PostgreSQL/S3 跳过，管理端测试 2/2，真实 Chromium E2E 通过。
结构检查仅被任务前已有的两个 `_work/` 中文目录名拦截。

真实微信开发者工具复测通过：iPhone 12/13 模拟器 `390×753`，隐私授权与关于弹层可用，健康
档案 2 条匿名记录的操作按钮均在视口内，学一学显示受控未开放提示，问助手显示不可用态，
DevTools 异常 0；截图保存在 `_work/20260828-miniprogram-e2e/`。本计划关联的 #378–#380
可在 PR、CI 和预览包证据齐全后关闭；正式网络联调仍需客户提供合法 HTTPS 域名。
