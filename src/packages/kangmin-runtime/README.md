# @kangmin/runtime

唯一组合根。这里只负责把 `@kangmin/core` 的业务端口与 `@kangmin/database`、`@kangmin/integrations` 的实现组装起来，并提供患者、管理和远程命令运行时入口。

CLI 与 API 只能依赖本包及 core 契约，不得直接选择数据库后端或外部适配器。
