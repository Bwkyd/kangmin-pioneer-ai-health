# 测试归属

小程序综合行为回归由根测试 `tests/miniprogram-shell.test.ts` 承载；本轮新增的逐页回归用例
放在同目录的 `tests/miniprogram-regression.test.ts`，避免继续增长既有长文件，也避免在 core
完成迁移前从 app 跨 workspace 相对导入临床题面。工程壳与身份配置由
`scripts/check-miniprogram.mjs` 检查；针对真实逐页 E2E 发现的配置、错误展示、窄屏结构和
入口行为，使用 `npm run test:smoke:miniprogram` 运行带 Issue 编号的源码级回归门禁。

健康档案实际像素边界、换行和点击反馈仍必须按
`docs/experiments/040_miniprogram-e2e-regression-checks.md` 在微信开发者工具复核。本轮用本机
已有自动化工具完成了匿名本地 fixture 的 `390×753` 复测；截图仅放在 `_work/`，不复制患者数据、
不作为真机或客户验收替代。
