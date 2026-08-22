# 008 腾讯云正式环境切换方案

状态：Web 试用环境已部署，待客户确认；正式云切换待资源
日期：2026-08-11
代码基线：由 `main@9b1b7b3` 开始改造，业务实现合并为 `6ae634a`

## 已确认边界

- 数据库：腾讯云托管 PostgreSQL，应用只使用同地域私网连接。
- 素材：腾讯云 COS，通过 S3 兼容接口和预签名直传访问。
- 小程序：AppID `wxec3aeaadcddaf45e`；AppSecret 仅存服务器密钥配置。
- 交付阶段：当前只部署 Web 供客户确认；原生小程序及体验码更新放到 Web 功能确认后的最后阶段。
- 推送：小程序内全员广播站内消息，不启用微信订阅消息。
- 调理方案后台编辑：报价单未包含，本次不交付。
- 环境数据：报价范围未包含，生产显式关闭；相关命令保持不可用。

## 上线前仍需作者确认

1. 正式主管理员账号；初始密码经安全通道交付并在首次登录后修改。
2. 现有试用患者数据是否全部清除。默认建议只迁移已发布内容、知识与配置，不迁移试用身份、会话和健康记录。
3. PostgreSQL、COS 的实际实例规格与费用预算；数据库需启用自动备份和删除保护。
4. 隐私政策版本、健康数据保存期限、注销后删除期限和运营主体全称。
5. 在正式生产前轮换当前 DeepSeek API Key，并更新服务器权限 `0600` 的环境文件；旧 Key 完成撤销后再做模型链路验收。

小程序运营主体、合法域名、真机授权与体验码更新均延后到小程序阶段，不阻断本轮 Web 部署。

## 切换步骤

1. 在 `ap-beijing` 创建 PostgreSQL 与 COS，限制为应用服务器安全组/子网访问。
2. 从 `src/.env.example` 生成服务器专用 `.env.production`，权限设为 `0600`；不得进入镜像、Git 或命令历史。
3. 构建镜像后先运行 `/live`、`/ready`；`/ready` 五项全部为 `ok` 才允许接入流量。
4. 先迁移内容、知识、方案注册表和管理员配置；试用患者数据按确认结果单独处理。
5. 配置 HTTPS 反向代理，使用浏览器验证患者 Web 与管理 Web；保持 `KANGMIN_WECHAT_ENABLED=0`。
6. 验证管理端文章、视频、知识和站内消息的新增、发布、下架，以及患者端消息已读隔离。
7. 保留旧环境只读回退窗口；新环境观察无误后再安排旧数据清理，不在切换脚本中自动删除。

## 验证与限制

- 自动验证：`npm run check`、PostgreSQL 契约测试、对象存储契约测试、HTTP E2E、Docker 构建。
- COS SecretKey、数据库密码目前未提供，无法在本地完成正式 PostgreSQL/COS 云联调；本轮先部署现有 Web 试用环境验证功能。
- 隐私条款与试用数据处置未确认前，不执行正式数据迁移。
- 小程序工程与微信审核不属于当前 Web 阶段，待客户确认 Web 功能后另行实施。

## Web 试用环境部署记录

- 2026-08-11 将提交 `b8246fb` 部署至 `https://49.232.26.48`，服务仍沿用现有 SQLite 与本地素材目录，仅用于客户 Web 功能确认，不冒充 PostgreSQL/COS 正式环境。
- 新 release 先后通过空库和线上数据库副本 8788 预检；副本迁移由 17 项升至 20 项且 `PRAGMA quick_check` 为 `ok`。
- 停服切换前备份至 `/srv/kangmin-cli/data/backups/kangmin-mvp-20260811-134712-before-b8246fb.sqlite`；当时 release 为 `/srv/kangmin-cli/releases/b8246fb5b65f6490061a82a2538db63b1516f4cf`，旧 release 保留回滚。
- 公网患者端、管理端、站内消息列表和知识问答冒烟通过，患者与管理 HTML 的 SHA-256 均与本地构建一致；服务 active，`NRestarts=0`。
- 服务器模型密钥已从 systemd 单元明文项迁入权限 `0600` 的 `/etc/kangmin-cli.env`；环境数据和微信登录均显式关闭。`/ready` 当前仅保留试用环境既有的加密密钥 `not_configured`，不作为正式生产就绪结论。
- 2026-08-14 将诊一诊受约束追问版本 `31c975a` 部署至同一 Web 试用环境；切换前备份为 `/srv/kangmin-cli/data/backups/kangmin-mvp-20260814-233337-before-switch-31c975a.sqlite`，旧 release 保留回滚。服务 active、`NRestarts=0`、数据库 `PRAGMA quick_check=ok`。
- 试用库仅新增并启用 1 条《福建省中医药适宜技术手册》迎香定位摘录，千问密钥只写入权限 `0600` 的服务器环境文件。公网模拟患者完成问卷后可追问迎香定位；模型输出不合规或波动时，仅展示再次通过同一方案边界校验的 enabled 知识原文。
- 公网浏览器验收确认回答含“鼻翼外缘中点旁开约 0.5 寸，鼻唇沟中”和资料名，不含斜刺、平刺或针刺建议；刷新后消息仍在、输入框可继续追问，控制台无 warning/error。`/ready` 仍只因试用环境未配置加密密钥返回 503。
- 2026-08-15 原服务器 `49.232.26.48` 到期后，按作者授权将同一 release `31c975a` 重建至
  腾讯云轻量服务器 `140.143.120.176`。旧机 SSH 在认证前断开且 HTTP/HTTPS 无响应，故未将
  “旧状态缓存”冒充迁移依据；若需精确恢复旧患者、会话、文章、视频和管理员状态，仍需临时
  续费旧实例或挂载其磁盘快照后另行导出。
- 新机使用经官方校验和验证的 Node.js `22.23.1`、systemd、Nginx 和本地 SQLite；应用只监听
  `127.0.0.1:8787`，公网由 `https://140.143.120.176` 反向代理。原机预装的 `myapp.service`
  仅停止并禁用，未删除。模型密钥仍只在权限 `0600` 的服务器环境文件中，微信与环境数据功能
  显式关闭。
- 新库由受控 seed 重建 11 个 enabled 方案，并按审核边界导入 1 条 enabled 的迎香定位切片；
  未伪造无法核验的旧患者、会话、文章或视频。公网模拟患者完成 14 题问卷，得到“缓解期 / 寒热
  错杂”，追问后返回正确定位且不含针刺操作，刷新后 1 个会话、36 条消息仍可恢复，浏览器无
  warning/error。
- Let's Encrypt 已为该 IPv4 签发 6 天短期 ECDSA 证书，systemd 定时器每日两次尝试续期；
  `certbot renew --dry-run` 已成功。应用、Nginx、续期定时器均 active/enabled，应用
  `NRestarts=0`，SQLite `quick_check=ok`；`/ready` 仍仅因试用环境未配置加密密钥为 503。
- 2026-08-15 根据作者对 AI 输出体验的反馈，把工作树构建为 release
  `stream-b060f7cf45d6` 并切换到新机；切换前数据库备份为
  `/srv/kangmin-cli/data/backups/kangmin-mvp-20260815-111624-before-stream.sqlite`，旧 release
  保留回滚。该 release 基于 `f6ae648` 加本轮未提交的流式改动，不能冒充对应 Git 提交。
- 患者端新增 HTTPS NDJSON 流式通道与递增正文/光标；Nginx 接收上游“不缓冲”标记。出于
  医学安全，千问原始 token 仍不会直接到达患者：模型完整输出先经既有医学边界校验并落库，
  通过后才分片展示。公网实际收到 5 次网络读取，分片正文与最终落库正文完全一致；断流时
  提示刷新恢复而非自动重复写入。
- 2026-08-15 部署患者级评估上下文 release `context-stable-20260815-1300`。SQLite 迁移升至
  `0019_patient_assessment_context`，问卷快照、规则版本、期别/证型与方案引用成为患者级评估
  档案；新聊天默认继承，重新评估才创建问卷，数据库唯一索引保证每位患者只有一份 current
  评估。切换前备份为 `/srv/kangmin-cli/data/backups/kangmin-mvp-20260815-1300-before-stable.sqlite`，
  旧 releases 全部保留。
- 手册继续按最小审核范围启用：除既有迎香定位外，仅新增大椎、肺俞、足三里三条非侵入性
  说明，共 4 条 enabled；未导入针刺、注射、剂量、时长或名单外穴位。泛问方案不检索知识，
  只有明确点名当前方案内穴位才检索，避免无关切片兜底。
- 公网模拟患者完整完成 Q1–Q14 后，新聊天取得独立 conversation id 且不重复问卷；连续两轮
  分别收到 34/33 个安全分片，正文不同、无固定拒绝、无无关知识召回，每条仅一个依据脚注。
  应用 active、`NRestarts=0`、SQLite `quick_check=ok`；`/ready` 仍仅受试用环境未配置加密密钥
  限制，本记录不等于正式生产就绪或客户验收。
- 2026-08-15 针对公网追问 18–26 秒的等待，确认 `qwen3.7-flash` 请求未显式关闭默认推理；
  部署 release `speed-no-thinking-20260815-1321`，统一发送 `enable_thinking=false`，纯寒暄改为
  确定性承接回复，真实医学追问仍保留“完整生成→医学校验→持久化→安全分片”的顺序。切换前
  备份为 `/srv/kangmin-cli/data/backups/kangmin-mvp-20260815-1323-before-speed-fix.sqlite`，旧 release
  保留回滚。公网无身份模拟患者实测：完整问卷 6.738 秒、寒暄 0.250 秒、携带完整评估上下文的
  真实追问 2.280 秒；千问直连验证为 0.582 秒且 reasoning 字符数为 0。应用与 Nginx active、
  `NRestarts=0`、SQLite `quick_check=ok`。
- 上述患者级评估、连续追问、安全分片与关闭推理改动已通过 PR #203 的 `quality`、`image`
  两项 CI，并于 2026-08-15 squash 合并为 `main@8ba09e5`。任务分支代码树与合并代码树完全
  一致；本次 Git 收尾不改变已验证的线上 release，也不重复部署。
- 2026-08-15 部署输入区动画助手 release `assistant-mascot-3897e11`。客户提供的 HEVC MP4
  保持只读，患者端使用去黑底、静音的透明循环 APNG，并为“减少动态效果”提供静态 PNG；
  两项资源经 HTTP 明确白名单提供。8788 + SQLite 副本预检通过后切换，切换前备份为
  `/srv/kangmin-cli/data/backups/kangmin-mvp-20260815-135659-before-assistant-mascot-3897e11.sqlite`，
  旧 release 保留。公网 APNG 返回 `image/apng` 且字节哈希与本地一致；Chrome 390×844
  验证透明动画、位置、输入操作和控制台均正常。应用/Nginx active、`NRestarts=0`、SQLite
  `quick_check=ok`；`/ready` 仍只因试用环境既有 encryption 未配置返回 503。
- 2026-08-15 根据客户截图修正动画助手毛边和文字遮挡，部署 release
  `assistant-mascot-fix-12ed9fa`。透明蒙版向内收紧，角色缩小并进入输入区左侧预留位；浏览器
  回归明确约束角色不得覆盖输入文字或评估完成提示。首次空闲端口预检因未显式携带 systemd
  的 local/dev 非密钥环境而安全失败，线上未切换；补齐一致环境后预检通过并原子切换。切换前
  备份为 `/srv/kangmin-cli/data/backups/kangmin-mvp-20260815-141051-before-assistant-mascot-fix-12ed9fa.sqlite`，
  旧 release 保留。公网 APNG 返回 `image/apng` 且哈希与 release 一致；应用/Nginx active、
  `NRestarts=0`、SQLite `quick_check=ok`。
- 2026-08-17 将非智能体报价闭环合并提交 `bad463b` 构建并部署为
  `/srv/kangmin-cli/releases/non-agent-closure-bad463b`。制品 SHA-256 为
  `b701cf6570e19ddca376a8755bc445f9a5c34a060879e8884dc6be18b750d6cd`；先在 8788 使用线上
  SQLite 在线备份副本预检患者页、管理页、21 项迁移与 `quick_check=ok`，再停服备份为
  `/srv/kangmin-cli/data/backups/kangmin-mvp-20260817-130359-before-non-agent-closure-bad463b.sqlite`
  并原子切换，旧 release 保留回滚。公网患者页、管理页及两端主 JS 与本地合并构建哈希一致，
  应用/Nginx active、`NRestarts=0`、SQLite `quick_check=ok`；当前无可连接图形浏览器，未声称
  完成本轮公网 UI 目测。`/ready` 仍只因试用环境既有 encryption 未配置返回 503。
- 2026-08-17 将知识库内嵌编辑提交 `bd78951` 构建并部署为
  `/srv/kangmin-cli/releases/knowledge-inline-bd78951`。制品 SHA-256 为
  `e6172ced718a51d7621309b99c5e5e582c84524c7f9b699d52c8aac385de011d`；先在 8788 使用线上
  SQLite 在线备份副本预检患者页、管理页、新管理 JS、21 项迁移与 `quick_check=ok`，再停服
  备份为 `/srv/kangmin-cli/data/backups/kangmin-mvp-20260817-132722-before-knowledge-inline-bd78951.sqlite`
  并原子切换，旧 release 保留回滚。公网患者页、管理页和新管理 JS 均为 200，管理 JS 与
  本地构建哈希一致；应用/Nginx active、`NRestarts=0`、SQLite `quick_check=ok`。真实浏览器
  E2E 已在本地覆盖知识编辑完整路径；`/ready` 仍只因试用环境既有 encryption 未配置返回 503。
- 2026-08-18 将报价内管理工作台 PR #222 的合并提交 `4c5ead7` 构建并部署为
  `/srv/kangmin-cli/releases/admin-workbench-4c5ead7`。发布包 SHA-256 为
  `54d002ce1347638192ed3daafdf126237aa3302d8eab97337dde80b89bc14e68`；先在 8788 使用线上
  SQLite 副本预检新管理端、数据库副本与 `quick_check=ok`，切换前备份为
  `/srv/kangmin-cli/backups/kangmin-mvp-20260818-173227-pre-deploy.sqlite`，旧
  `miniprogram-admin-7eb9323` 保留回滚。公网 `/live`、`/admin` 和新管理 bundle 均回读通过，
  应用/Nginx active、`NRestarts=0`；`/ready` 仍只因试用环境既有 encryption 未配置返回 503，
  不扩大为正式生产就绪或客户验收。
- 2026-08-18 根据截图继续收口管理后台可见文案，PR #224 将导航分组改为
  `内容运营`、`消息与素材`，PR #226 将工作台和四类管理页面的残留内部“报价/交付”话术改为
  运营任务语言；PR #226 squash 合并为 `main@5ffa49d`，部署 release
  `/srv/kangmin-cli/releases/admin-copy-cleanup-5ffa49d`。
- 本次切换前备份为
  `/srv/kangmin-cli/backups/kangmin-mvp-20260818-192108-before-admin-copy-cleanup.sqlite`，
  预检与切换后 `quick_check=ok`、服务 active、`NRestarts=0`，公网 `/live`、`/admin` 均为
  200，旧 release 保留回滚；PR #227 只补充状态与复核文档，不产生新的运行时部署。
- 2026-08-19 将 Issue #232 的内容录入闭环 PR #233 squash 合并为 `main@cb2d88b`，构建发布包
  SHA-256 为 `35d8b1d2211852744fb436d6e09b8fdc6702b0bc15015d6103a96b7cdf94aa28`，部署 release
  `/srv/kangmin-cli/releases/content-entry-cb2d88b`。先使用线上 SQLite 在线备份副本在 8788
  预检患者页、管理页、迁移和 `quick_check`，通过后切换前备份为
  `/srv/kangmin-cli/backups/kangmin-mvp-20260819-080256-before-content-entry-cb2d88b.sqlite`，
  旧 release 保留回滚。
- 切换后公网 `/live`、患者首页、`/admin` 均为 200，管理、患者和正文媒体 bundle 的公网哈希
  与 release 一致；应用 active、`NRestarts=0`、SQLite `quick_check=ok`。`/ready` 仍仅因试用
  环境未配置加密密钥返回 503，不扩大为正式生产就绪或客户验收。
- 2026-08-22 将 Issue #236 的语义知识检索 PR #240 squash 合并为 `main@af5d74a`，构建包
  SHA-256 为 `7e56e4675b7cdd35f7f80c95cc8637362b9fd332253917074ed7d342f7b5d416`，部署 release
  `/srv/kangmin-cli/releases/semantic-retrieval-af5d74a`。先在线备份生产 SQLite 副本，在 8788
  完成 22 项迁移、4 项知识/4 个切块真实向量回填、患者页、管理页和语义 Top-3 预检；再停服
  备份为 `/srv/kangmin-cli/backups/kangmin-mvp-20260822-101823-before-semantic-af5d74a.sqlite`
  并原子切换。切换后公网 `/live`、患者页、`/admin` 均为 200，患者 bundle SHA-256 为
  `1b67e91a39e149a5211d73a023c147a734efc53ede5ea1b8f626d00b2a8fb4ae` 且与 release 一致；
  应用 active、`NRestarts=0`、SQLite `quick_check=ok`，真实语义检索返回 Top-3 并含分类和
  相似度。`/ready=503` 仍仅因试用环境既有加密密钥未配置；预检数据库副本和临时制品已删除，
  正式备份与旧 release 保留回滚。
- 2026-08-22 将 Issue #237 的自然问答单步工具循环 PR #242 squash 合并为 `main@dd76967`，
  构建包 SHA-256 为 `b1d45385cd67bf8ef372de8cd0c146d015992e91c63a043f4a688584911e0a8e`，
  部署 release `/srv/kangmin-cli/releases/natural-agent-dd76967`。8788 线上库副本预检完成完整
  Q1–Q14 与真实“迎香位置”工具搜索，回答含定位和来源且无针刺建议；正式切换前备份为
  `/srv/kangmin-cli/backups/kangmin-mvp-20260822-110624-before-natural-agent-dd76967.sqlite`。
- 切换后服务 active、`NRestarts=0`、数据库 `quick_check=ok`，22 项迁移和 4 个向量不变；
  公网 `/live`、患者页、管理页均为 200，服务端与患者 bundle 哈希匹配，主要业务表计数未变。
  `/ready=503` 仍仅因试用环境既有加密密钥未配置；预检副本、日志和传输制品已删除，正式
  备份与旧 release 保留回滚。
- 2026-08-22 将 Issue #238 的医学硬事实发布条件 PR #244 squash 合并为 `main@530e23c`，
  构建包 SHA-256 为 `7a510d11ccb1169b77d4bc5c5f048d3e736e0e980bc10f44a8f9d8aa4b476023`，
  部署 release `/srv/kangmin-cli/releases/hard-fact-gate-530e23c`。8788 线上库副本预检完成
  Q1–Q14、真实千问艾灸概念题和“苍耳子塞鼻+喷剂加量”高风险题，回答自然降级且 NDJSON
  与历史一致；正式切换前备份为
  `/srv/kangmin-cli/backups/kangmin-mvp-20260822-120552-before-hard-fact-gate-530e23c.sqlite`。
- 切换后应用与 Nginx active、`NRestarts=0`，数据库和备份 `quick_check=ok`；22 项迁移、
  14 个患者、11 个方案、4 个 enabled 知识/4 个向量、0 个正式 Agent 会话和 7 个评估与
  切换前一致。公网 `/live`、患者页、管理页均为 200，硬事实门、服务端和患者 bundle 哈希
  匹配。`/ready=503` 仍仅因试用环境既有加密密钥未配置；临时制品均已删除，正式备份与旧
  release 保留回滚。
- 2026-08-22 将 Issue #246 的福建手册受控知识 PR #247 squash 合并为 `main@d3d55c6`，
  以无 macOS 扩展属性的制品 SHA-256
  `69384830af64c86be49387c5dfa4a5957db17a0abea4ab2ee4b55f3e93d51181` 部署 release
  `/srv/kangmin-cli/releases/manual-knowledge-d3d55c6`。8788 线上库副本完成 17 项导入、132 个
  新切块、17/17 检索、5/5 高风险拒答和三条低风险问答；正式切换前备份为
  `/srv/kangmin-cli/backups/kangmin-mvp-20260822-151925-before-manual-d3d55c6.sqlite`。
- 切换后 21 份知识均 enabled，136 个切块/向量；22 项迁移、14 个患者、11 个方案、19 个
  会话和 7 个评估保持不变。应用与 Nginx active、`NRestarts=0`，数据库与备份
  `quick_check=ok`；公网 `/live`、患者页、管理页均为 200，关键后端与前端 bundle 哈希和
  本地合并构建一致。`/ready=503` 仍仅因试用环境既有加密密钥未配置，正式备份和旧 release
  保留回滚。
