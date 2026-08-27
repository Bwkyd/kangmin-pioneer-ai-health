# 测试归属

小程序综合行为回归暂由根测试 `tests/miniprogram-shell.test.ts` 承载，避免在 core 完成迁移前
从 app 跨 workspace 相对导入临床题面。工程壳与身份配置由 `scripts/check-miniprogram.mjs`
检查；后续只在依赖方向允许时移动测试，不复制 fixture。
