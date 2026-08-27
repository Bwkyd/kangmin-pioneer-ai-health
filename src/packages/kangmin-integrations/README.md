# @kangmin/integrations

外部系统适配器包。它只实现 `@kangmin/core` 定义的端口，不决定业务规则。

固定采用七个能力目录：

- `ai/`：模型与向量服务；
- `storage/`：本地与 S3 对象存储；
- `identity/`：微信身份交换；
- `security/`：字段加密；
- `environment/`：环境数据供应商及失败关闭替身；
- `clinical/`：只读证型注册表；
- `operations/`：远程命令客户端与脱敏日志。

未配置、超时、非法端点或上游失败继续按既有 `DomainError` 语义失败关闭。密钥不得进入日志、参数、仓库或前端。
