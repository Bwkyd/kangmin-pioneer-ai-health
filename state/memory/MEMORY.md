# kangmin 记忆索引（仓内记忆库）

> 项目记忆一律读写本目录（有 Git 远端、worktree 一致）；涉及个人隐私的记忆留在用户目录。

> 写法：只写规则与做法，不写出处、原话、日期叙事。命名 `YYYYMMDD-slug.md`（最后更新日期制，更新即改名并同步本索引）。索引不超过 20 KB。

- [微信小程序上传分层验收与 CLI 服务端口收尾](20260826-wechat-cli-upload-and-closeout.md) — 区分工程检查、上传接口成功与真机/体验版/审核验收，隔离项目身份配置，复用单一预览窗口并安全关闭本机服务端口
- [深层 CLI 命令必须走真实进程验收](20260826-cli-entrypoint-real-process-e2e.md) — 应用层可执行不代表 CLI 入口可达；以真实进程覆盖最长命令解析、参数、失败路径和发布制品
- [响应式界面必须验证实际几何](20260826-responsive-ui-geometry-e2e.md) — CSS 声明存在不等于布局成立；用双视口、计算样式、实际边界和旧功能正负断言防假绿
- [跨端同构按当前基准逐页有界验证](20260824-cross-platform-parity-bounded-validation.md) — 以当前运行端为唯一基准，逐页设停止线并用分层证据和负向回归防旧版分叉回流
- [小程序交互命中区与图标几何同源](20260824-miniprogram-hitbox-geometry.md) — 固定视图同时约束视觉与点击范围，用 CSS 几何和正负坐标点击防偏移与误触
- [报价范围先于产品补全](20260818-scope-authority-before-planning.md) — 只有现行报价 truth 能授权范围，代码缺口和产品建议不自动升级
- [决策前置化与确定性分流](20260818-decision-prioritization.md) — 可确定、可逆且授权内的直接推进，真实分叉前置给作者
- [部署目标与运行路径先核实](20260826-deploy-target-verify.md) — 从 systemd 实际配置解析服务、代码、数据与 release，后验验证不重新猜路径
- [智能体调研先定角色：患者科普问答型](20260818-agent-lens-patient-qa.md) — 规则与 truth 负责裁决，知识库只提供检索依据，模型不自主诊断
- [清理前核对主状态与 squash 等价性](20260827-reconcile-local-board-before-cleanup.md) — worktree 收尾前核对主状态、PR、required check 与文件树等价，再安全清理 squash 源分支
- [演化基线只能收紧不能复用旧额度](20260827-evolution-baseline-tightening.md) — 存量例外带责任与期限，新增守线、存量不增长、改善即收紧，并用已暂存负例验证门禁真会失败
- [管理后台可见文案全量盘点](20260818-admin-copy-surface-inventory.md) — 后台命名调整覆盖所有可见表面，并用正向与旧术语负向回归锁定
- [管理后台按运营任务组织而非暴露基础设施](20260826-admin-task-oriented-information-architecture.md) — 一级入口对应运营任务，存储、索引和引用管理留在流程内部或二级入口，并让分页保留任务上下文
- [患者内容分类必须显式归属](20260826-explicit-content-category-authority.md) — 后台与患者端共用稳定分类标识；运行时禁止标题猜测，迁移未决项失败关闭
- [模板对齐必须核对完整生成清单](20260818-template-alignment-full-inventory.md) — 在隔离目录生成基线，区分真实缺失、项目定制和本地特例
- [零材料模板不得制造隐性授权](20260818-zero-context-template-authority.md) — 未核实事实明确待核实，初始化不默认扩大人或 AI 的权限
- [双后端迁移同步纪律](20260809-dual-backend-migrations.md) — SQLite 与 PG 迁移必须同步写，CI 的 PG 契约测试会暴露缺失
- [持久化 ID 必须权威回读](20260809-persisted-id-rehydration.md) — 只保存实体 ID 会造成刷新后的前后端状态错位，恢复时必须回读正文与终态
- [患者可见状态保持单一来源](20260809-patient-visible-state.md) — 过滤、截断或映射后的有效问答状态必须由正文、结构化响应、持久化和恢复共同使用
- [有序决策树必须保留节点身份](20260809-ordered-tree-node-identity.md) — 同题二次确认是独立节点，不能压成单字段并行规则而丢失路径与终止语义
- [多来源资料必须按职责编译](20260809-source-role-contract.md) — 页面、规则与方案分别控制展示、跳转和叶后内容，不能互相越权补全
- [资料移动必须锁定清单与动作语义](20260811-material-relocation-scope.md) — 移动不得扩大为删除、加工或归档其他文件，忽略区操作前后核对清单与哈希
- [检索候选只是回答上下文，不是患者侧引用](20260823-retrieval-context-not-attribution.md) — Top-k 不等于实际采用或临床授权；无贴合资料可正常回答，患者侧不冒充来源
- [生成式输出先验证再流式展示](20260815-validated-output-streaming.md) — 高风险患者输出先完整校验并落库，再分片展示；断流从权威存储恢复而不自动重写
- [Web 编辑请求只提交可编辑字段](20260817-web-edit-dto-whitelist.md) — 读模型不得整体展开回写；用字段白名单和创建→编辑→回读浏览器路径防隐藏字段破坏更新
- [内容关联必须全量可达并在消费时复核](20260823-content-link-completeness-and-revalidation.md) — 关联查找不能只看首屏；分页去重终止、详情状态复核并防近似内容误配
