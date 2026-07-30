# 新实现入口

这里是重新设计后的 CLI-first 实现。顶层业务命令严格分为：

- `consult`：核心问诊和安全流程；
- `health`：核心健康记录；
- `content`：次要内容管理；
- `control`：次要治理和审计。

运行：

```bash
npm run build
node src/cli.mjs --help
node src/cli.mjs control capability list --json
```

详细命令边界见 `docs/architecture/four-group-cli.md`。

前端壳后续调用与 CLI 相同的应用服务，不直接执行 CLI 进程。旧产品仅作为行为和验收参考；新代码不得导入 `legacy/` 内的业务状态或框架模块。
