---
name: 部署目标先核实
description: 服务器多服务并存时先确认哪个服务对应哪个代码栈，再构建打包
metadata:
  type: feedback
---

部署前先核实**目标服务**：同一台服务器可能并存多个 systemd 服务与代码栈（如 49.232.26.48 上 `kangmin-pioneer` 是旧 vinext/wrangler 栈，`kangmin-cli` 才是本地 `@kangmin/patient-core` 项目的部署，caddy 反代端口不同）。按服务名/ExecStart/WorkingDirectory/releases 命名（commit hash 或 verified 标记）交叉确认，别按记忆中的服务名想当然。

**Why:** 2026-08-09 开发轮先按 board 旧记录假设部署目标，ssh 验证时发现 /opt/cezhang、kangmin-pioneer 都是别的东西；kangmin-cli 的 releases 按 commit hash 命名（4ac5d69/cc79ac5）才暴露真实部署路径。

**How to apply:** 部署前 ssh 只读验证：`systemctl cat <服务名>` 看 ExecStart/WorkingDirectory/EnvironmentFile → 与本地项目 package.json scripts/结构比对 → 确认数据库路径与备份惯例（`data/backups/*-before-<sha>.sqlite`）→ 再构建打包。macOS 打包注意：bsdtar 无 `--transform` 用 `-s`；打包目录前排除 `.env.local`/`.DS_Store` 等敏感与噪音文件。
