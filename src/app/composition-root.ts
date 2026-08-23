/**
 * 组合根：唯一允许把基础设施/适配器注入领域模块的地方。
 *
 * 加密密钥策略（fail-closed）：
 * - 配置了 KANGMIN_ENCRYPTION_KEYS → AES-256-GCM（首个条目为当前版本）；
 * - 未配置密钥且 KANGMIN_APP_ENV 为 local/integration，或显式
 *   KANGMIN_ALLOW_DEV_SESSION=1 → 明文开发实现（plaintext-dev，
 *   生产语义下读取会被拒绝）；
 * - 其余任何环境（含默认）→ 启动失败 config_missing，绝不在缺少
 *   密钥时明文启动。
 *
 * 问卷候选提取沿用 DeepSeek；规则结果动态转译、方案后追问与知识问答
 * 使用通义千问。任一提供方未配置或失败均降级到确定性问答或固定提示。
 *
 * 环境 Provider 门禁（fail-closed，与加密降级同一谓词）：测试替身仅在
 * KANGMIN_APP_ENV 为 local/integration，或显式 KANGMIN_ALLOW_DEV_SESSION=1
 * （且非 staging/production）时启用；其余环境（含 CLI 默认未设
 * KANGMIN_APP_ENV）注入 UnavailableEnvironmentProvider，环境命令抛
 * provider_unavailable，绝不返回测试桩固定假数据。
 *
 * 方案浏览门禁：与临床规则包冻结状态同源（评审 P1-12）——生效规则包
 * （options.rulePackage ?? DRAFT_RULE_PACKAGE）status 为 approved 时注入
 * planBrowseEnabled=true；默认 clinical-rules-v3 已启用，Web 试用即放开，
 * SQLite 与 PostgreSQL 路径同一派生，不再读环境变量。
 *
 * 生产存储策略（fail-closed，见 assertProductionStorage）：
 * KANGMIN_APP_ENV=staging|production 时缺 PostgreSQL 连接串、缺对象
 * 存储桶、环境 Provider 仍是测试替身、或出现开发会话开关，一律
 * config_missing 拒绝启动；local/integration 不校验（本地零影响）。
 */

import { DomainError } from "../kernel/errors.js";
import type { EncryptionPort } from "../kernel/encryption.js";
import { dirname, join } from "node:path";
import {
  KangminApplication,
  type DoctorCheck,
  type DoctorReport
} from "./application.js";
import { KangminDatabase, appliedMigrationVersions } from "../infrastructure/database.js";
import {
  AesGcmEncryption,
  parseEncryptionKeys,
  PlaintextEncryption
} from "../infrastructure/aes-gcm-encryption.js";
import {
  KangminPgDatabase,
  appliedPgMigrationVersions
} from "../infrastructure/postgres/pg-database.js";
import { PG_MIGRATIONS } from "../infrastructure/postgres/pg-migrations.js";
import { PgAccountRepository } from "../infrastructure/postgres/pg-account-repository.js";
import { PgAgentRepository } from "../infrastructure/postgres/pg-agent-repository.js";
import { PgContentReadRepository } from "../infrastructure/postgres/pg-content-read-repository.js";
import { PgConversationRepository } from "../infrastructure/postgres/pg-conversation-repository.js";
import { PgEnvironmentCacheRepository } from "../infrastructure/postgres/pg-environment-cache-repository.js";
import { PgPlanRegistry } from "../infrastructure/postgres/pg-plan-registry.js";
import { PgRecordRepository } from "../infrastructure/postgres/pg-record-repository.js";
import { PgSessionRepository } from "../infrastructure/postgres/pg-session-repository.js";
import { SqliteAccountRepository } from "../infrastructure/sqlite-account-repository.js";
import { SqliteAgentRepository } from "../infrastructure/sqlite-agent-repository.js";
import { SqliteContentReadRepository } from "../infrastructure/sqlite-content-read-repository.js";
import { SqliteConversationRepository } from "../infrastructure/sqlite-conversation-repository.js";
import { SqliteEnvironmentCacheRepository } from "../infrastructure/sqlite-environment-cache-repository.js";
import { SqlitePlanRegistry } from "../infrastructure/sqlite-plan-registry.js";
import { SqliteRecordRepository } from "../infrastructure/sqlite-record-repository.js";
import { SqliteSessionRepository } from "../infrastructure/sqlite-session-repository.js";
import { TestEnvironmentProvider } from "../infrastructure/test-environment-provider.js";
import { UnavailableEnvironmentProvider } from "../infrastructure/unavailable-environment-provider.js";
import { DeepSeekModelAdapter } from "../infrastructure/deepseek-model-adapter.js";
import { QwenPlanDialogueAdapter } from "../infrastructure/qwen-plan-dialogue-adapter.js";
import { LocalFilesystemObjectStorage } from "../infrastructure/local-filesystem-object-storage.js";
import { S3ObjectStorage } from "../infrastructure/s3-object-storage.js";
import { WechatCodeLogin } from "../infrastructure/wechat-code-login.js";
import { SqliteKnowledgeRetrieval } from "../infrastructure/sqlite-knowledge-retrieval.js";
import { PgKnowledgeRetrieval } from "../infrastructure/postgres/pg-knowledge-retrieval.js";
import { DashscopeEmbeddingAdapter } from "../infrastructure/dashscope-embedding-adapter.js";
import type {
  ObjectHead,
  ObjectStoragePort,
  ObjectUploadTicket
} from "../modules/system/object-storage-ports.js";

// 结构化请求日志的唯一实现在 infrastructure；经组合根再导出，
// 供 http 适配层引用（架构约束：cli/http/dev 不直接依赖 infrastructure）。
export {
  createStructuredRequestLogger,
  logLevelForStatus,
  type RequestLogEntry,
  type RequestLogger,
  type StructuredLogLevel
} from "../infrastructure/structured-logger.js";
import { AccountService } from "../modules/account/account-service.js";
import { SessionService } from "../modules/account/session-service.js";
import { ConsentGateAdapter } from "./consent-gate-adapter.js";
import { ConversationService } from "../modules/agent/conversation-service.js";
import type { ConversationRepository } from "../modules/agent/conversation-repository.js";
import type {
  ModelExplanationPort,
  ModelExtractionPort,
  PlanDialoguePort
} from "../modules/agent/model-ports.js";
import { ClinicalRuleKernel } from "../modules/clinical-rules/clinical-rule-kernel.js";
import type { PlanRegistryPort } from "../modules/clinical-rules/contracts.js";
import type { RulePackage } from "../modules/clinical-rules/domain.js";
import { DRAFT_RULE_PACKAGE } from "../modules/clinical-rules/rule-package.js";
import type { EnvironmentProviderPort } from "../modules/environment/environment-ports.js";
import type { WechatLoginPort } from "../modules/account/wechat-login-port.js";
import { KnowledgeQaService } from "../modules/agent/knowledge-qa.js";
import type {
  KnowledgeAnswerPort,
  KnowledgeEmbeddingPort,
  KnowledgeRetrievalPort
} from "../modules/agent/knowledge-ports.js";

/** HTTP 入口使用的微信登录适配器工厂，保持基础设施依赖只出现在组合根。 */
export function createWechatLogin(appId: string, appSecret: string): WechatLoginPort {
  return new WechatCodeLogin({ appId, appSecret });
}

export type AppEnvironment = "local" | "integration" | "staging" | "production";

export interface ApplicationOptions {
  /** 显式注入加密端口；未提供时按环境解析（见 resolveEncryption）。 */
  encryption?: EncryptionPort;
  /** 环境 Provider 注入点（测试用）；默认使用测试替身适配器。 */
  environmentProvider?: EnvironmentProviderPort | undefined;
  /** 模型候选提取端口（测试用）；默认 DeepSeek 适配器。 */
  extraction?: ModelExtractionPort | undefined;
  /** 模型解释端口（测试用）；默认 DeepSeek 适配器。 */
  explanation?: ModelExplanationPort | undefined;
  /** 规则结果动态转译与方案后追问端口；默认通义千问。 */
  planDialogue?: PlanDialoguePort | undefined;
  /** 方案后追问的已启用知识检索端口（测试用）。 */
  planKnowledgeRetrieval?: KnowledgeRetrievalPort | undefined;
  /** 独立知识问答模型端口（评测观察/测试用）；缺省使用千问。 */
  knowledgeAnswer?: KnowledgeAnswerPort | undefined;
  /** 知识语义向量端口（测试用）；默认使用 DashScope。 */
  knowledgeEmbedding?: KnowledgeEmbeddingPort | undefined;
  /** 方案注册表端口；未提供时读取数据库中已启用的统一方案表。 */
  planRegistry?: PlanRegistryPort | undefined;
  /** 临床规则包注入点（测试用）；默认加载 approved 包 clinical-rules-v3。 */
  rulePackage?: RulePackage | undefined;
  /** 显式覆盖 KANGMIN_APP_ENV（测试用）；未提供时读环境变量。 */
  appEnvironment?: AppEnvironment | undefined;
  /**
   * PostgreSQL 连接串；未提供时回退 KANGMIN_DATABASE_URL 环境变量。
   * 配置后使用 PostgreSQL 存储，缺省保持 SQLite（local/integration）。
   */
  databaseUrl?: string | undefined;
  /**
   * 显式注入对象存储端口（测试/远程编排）；未提供时按
   * resolveObjectStorage 解析（KANGMIN_S3_BUCKET → S3，否则本地目录）。
   * 患者侧用于 HTTP 媒体路由读取已发布内容引用的媒体字节。
   */
  objectStorage?: ObjectStoragePort | undefined;
  /**
   * 本地对象存储根目录（未配置 S3 时生效）；默认
   * KANGMIN_ADMIN_MEDIA_DIR 或 <数据库目录>/admin-media（与管理端一致，
   * 媒体路由才能读到管理端上传的字节）。
   */
  mediaDirectory?: string | undefined;
}

/** 解析存储后端：显式参数优先，其次 KANGMIN_DATABASE_URL。 */
export function resolveDatabaseUrl(
  options: { databaseUrl?: string | undefined } = {},
  environment: NodeJS.ProcessEnv = process.env
): string | undefined {
  const explicit = options.databaseUrl?.trim();
  if (explicit !== undefined && explicit !== "") {
    return explicit;
  }
  const fromEnvironment = environment.KANGMIN_DATABASE_URL?.trim();
  return fromEnvironment === undefined || fromEnvironment === ""
    ? undefined
    : fromEnvironment;
}

/** 本地素材目录默认位置：<数据库目录>/admin-media（患者/管理组合根共用）。 */
export function defaultMediaDirectory(databasePath: string): string {
  return join(dirname(databasePath), "admin-media");
}

/**
 * 本地存储延迟创建：LocalFilesystemObjectStorage 构造即创建根目录，若
 * 组合根启动时就实例化，素材目录会被提前创建，doctor 的"目录缺失或不可
 * 读写即 failed"语义失效（既有 CLI 契约：未引导环境 doctor 不健康）。
 * 首次实际读写时才创建目录，保持既有 doctor 行为。
 */
class LazyLocalObjectStorage implements ObjectStoragePort {
  private inner: LocalFilesystemObjectStorage | undefined;

  constructor(private readonly rootDirectory: string) {}

  private storage(): LocalFilesystemObjectStorage {
    this.inner ??= new LocalFilesystemObjectStorage(this.rootDirectory);
    return this.inner;
  }

  putObject(input: {
    key: string;
    body: Buffer;
    contentType?: string | undefined;
  }): Promise<void> {
    return this.storage().putObject(input);
  }

  getObject(key: string): Promise<Buffer> {
    return this.storage().getObject(key);
  }

  headObject(key: string): Promise<ObjectHead | null> {
    return this.storage().headObject(key);
  }

  deleteObject(key: string): Promise<void> {
    return this.storage().deleteObject(key);
  }

  createUploadTicket(input: {
    key: string;
    contentType: string;
    sizeBytes: number;
    sha256: string;
  }): Promise<ObjectUploadTicket> {
    return this.storage().createUploadTicket(input);
  }

  acceptUploadTicket(input: { token: string; body: Buffer }): Promise<void> {
    return this.storage().acceptUploadTicket(input);
  }

  verifyObject(input: {
    key: string;
    sha256: string;
    sizeBytes: number;
  }): Promise<boolean> {
    return this.storage().verifyObject(input);
  }
}

/**
 * 对象存储选择（患者/管理组合根共用，媒体交付链 issue-151）：显式注入
 * 优先（测试/远程编排）；否则 KANGMIN_S3_BUCKET 存在 → S3 兼容后端
 * （缺访问凭证抛 config_missing）；否则本地文件系统（mediaDirectory
 * 照旧解析，语义与改造前一致）。staging/production 强制 S3 由
 * assertProductionStorage 在装配入口校验。
 */
export function resolveObjectStorage(
  options: { objectStorage?: ObjectStoragePort | undefined },
  mediaDirectory: string
): ObjectStoragePort {
  if (options.objectStorage !== undefined) {
    return options.objectStorage;
  }
  const bucket = process.env.KANGMIN_S3_BUCKET;
  if (bucket !== undefined && bucket.trim() !== "") {
    const accessKeyId = process.env.KANGMIN_S3_ACCESS_KEY_ID ?? "";
    const secretAccessKey = process.env.KANGMIN_S3_SECRET_ACCESS_KEY ?? "";
    if (accessKeyId === "" || secretAccessKey === "") {
      throw new DomainError(
        "config_missing",
        "已配置 KANGMIN_S3_BUCKET，但缺少 KANGMIN_S3_ACCESS_KEY_ID / KANGMIN_S3_SECRET_ACCESS_KEY"
      );
    }
    return new S3ObjectStorage({
      bucket,
      endpoint: process.env.KANGMIN_S3_ENDPOINT || undefined,
      region: process.env.KANGMIN_S3_REGION || "us-east-1",
      accessKeyId,
      secretAccessKey,
      forcePathStyle:
        process.env.KANGMIN_S3_FORCE_PATH_STYLE === undefined
          ? undefined
          : process.env.KANGMIN_S3_FORCE_PATH_STYLE === "1",
      signedChecksum:
        process.env.KANGMIN_S3_SIGN_CHECKSUM === undefined
          ? undefined
          : process.env.KANGMIN_S3_SIGN_CHECKSUM === "1"
    });
  }
  return new LazyLocalObjectStorage(mediaDirectory);
}

/**
 * 开发降级谓词（fail-closed，加密降级与环境测试替身共用）：
 * 仅 KANGMIN_APP_ENV 为 local/integration，或显式
 * KANGMIN_ALLOW_DEV_SESSION=1（且非 staging/production）时允许；
 * 其余任何环境（含默认未设 KANGMIN_APP_ENV）拒绝。
 */
function developmentFallbackAllowed(environment: NodeJS.ProcessEnv): boolean {
  const appEnvironment = environment.KANGMIN_APP_ENV;
  return (
    appEnvironment === "local" ||
    appEnvironment === "integration" ||
    (environment.KANGMIN_ALLOW_DEV_SESSION === "1" &&
      appEnvironment !== "staging" &&
      appEnvironment !== "production")
  );
}

/**
 * 生产存储与依赖 fail-closed 校验（staging/production 才生效）：
 * - 缺 KANGMIN_DATABASE_URL → config_missing（禁止回退 SQLite）；
 * - 缺 KANGMIN_S3_BUCKET → config_missing（禁止回退本地素材目录）；
 * - KANGMIN_ENV_PROVIDER_MODE 已设置（测试替身故障模式开关）→ config_missing；
 * - 环境功能启用时 Provider 仍是测试替身或不可用占位 → config_missing；
 * - 报价范围未包含环境数据时可显式 KANGMIN_ENVIRONMENT_ENABLED=0，
 *   此时环境命令保持不可用，但不阻断其余生产能力；
 * - KANGMIN_ALLOW_DEV_SESSION=1 → config_missing（连开发会话开关都
 *   不允许出现，路由层拒绝之外再压一道）。
 * local/integration 直接返回，本地开发与集成测试零影响。
 */
export function assertProductionStorage(
  environment: NodeJS.ProcessEnv,
  context: { environmentProvider?: EnvironmentProviderPort | undefined } = {}
): void {
  const appEnvironment = environment.KANGMIN_APP_ENV;
  if (appEnvironment !== "staging" && appEnvironment !== "production") {
    return;
  }
  if (environment.KANGMIN_ALLOW_DEV_SESSION === "1") {
    throw new DomainError(
      "config_missing",
      "staging/production 不允许设置 KANGMIN_ALLOW_DEV_SESSION=1（开发会话开关）"
    );
  }
  if (resolveDatabaseUrl({}, environment) === undefined) {
    throw new DomainError(
      "config_missing",
      "staging/production 必须配置 KANGMIN_DATABASE_URL（PostgreSQL），禁止回退 SQLite"
    );
  }
  const bucket = environment.KANGMIN_S3_BUCKET?.trim();
  if (bucket === undefined || bucket === "") {
    throw new DomainError(
      "config_missing",
      "staging/production 必须配置 KANGMIN_S3_BUCKET（对象存储），禁止回退本地素材目录"
    );
  }
  const providerMode = environment.KANGMIN_ENV_PROVIDER_MODE?.trim();
  if (providerMode !== undefined && providerMode !== "") {
    throw new DomainError(
      "config_missing",
      "staging/production 不允许设置 KANGMIN_ENV_PROVIDER_MODE（测试替身故障模式开关）"
    );
  }
  if (
    environment.KANGMIN_ENVIRONMENT_ENABLED !== "0" &&
    (context.environmentProvider instanceof TestEnvironmentProvider ||
      context.environmentProvider instanceof UnavailableEnvironmentProvider)
  ) {
    throw new DomainError(
      "config_missing",
      "staging/production 必须接入真实环境数据供应商（当前为测试替身或不可用占位）"
    );
  }
}

/** /ready 单项探针结果：name 由探针声明，server 负责拼装输出。 */
export interface ReadinessCheckResult {
  status: "ok" | "failed" | "not_configured";
  message: string;
}

/** 就绪探针：组合根注入 HTTP 适配层，server 不直接触碰仓储。 */
export interface ReadinessProbe {
  name: string;
  run: () => Promise<ReadinessCheckResult>;
}

/** 患者侧 /ready 探针集（对象存储探针由管理端组合根提供）。 */
export interface PatientReadinessProbes {
  database: ReadinessProbe;
  encryption: ReadinessProbe;
  environmentProvider: ReadinessProbe;
  rulePackage: ReadinessProbe;
}

export interface ApplicationWithOps {
  application: KangminApplication;
  readinessProbes: PatientReadinessProbes;
}

/** PostgreSQL 探针：SELECT 1 + 已应用迁移与代码 PG_MIGRATIONS 全量对齐。 */
function pgDatabaseReadinessProbe(database: KangminPgDatabase): ReadinessProbe {
  return {
    name: "database",
    run: async () => {
      try {
        await database.query("SELECT 1");
        const applied = new Set(await appliedPgMigrationVersions(database));
        const expected = PG_MIGRATIONS.map((migration) => migration.version);
        const aligned =
          applied.size === expected.length &&
          expected.every((version) => applied.has(version));
        return aligned
          ? { status: "ok", message: "数据库可用，迁移版本与代码对齐" }
          : {
              status: "failed",
              message: "数据库迁移版本与代码不一致，需先执行迁移"
            };
      } catch {
        // 固定文案，不拼接底层错误细节（可能含连接串/内部信息）。
        return { status: "failed", message: "数据库不可用" };
      }
    }
  };
}

/**
 * SQLite 探针（local/integration）：SELECT 1 + 迁移账本非空。
 * SQLite 迁移清单未导出，版本对齐只在 PG 路径强校验；生产由
 * assertProductionStorage 强制 PG，本探针不服务生产语义。
 */
function sqliteDatabaseReadinessProbe(database: KangminDatabase): ReadinessProbe {
  return {
    name: "database",
    run: async () => {
      try {
        database.connection.prepare("SELECT 1").get();
        return appliedMigrationVersions(database).length > 0
          ? { status: "ok", message: "数据库可用" }
          : { status: "failed", message: "数据库没有任何已应用迁移" };
      } catch {
        return { status: "failed", message: "数据库不可用" };
      }
    }
  };
}

/** 加密探针：仅确认密钥已配置，不输出密钥本身。 */
function encryptionReadinessProbe(
  environment: NodeJS.ProcessEnv
): ReadinessProbe {
  return {
    name: "encryption",
    run: () =>
      Promise.resolve(
        parseEncryptionKeys(environment.KANGMIN_ENCRYPTION_KEYS).length > 0
          ? { status: "ok", message: "已配置加密密钥" }
          : {
              status: "not_configured",
              message: "未配置加密密钥（明文开发降级，仅限 local/integration）"
            }
      )
  };
}

/** 环境 Provider 探针：测试替身或 R1 门禁不可用占位都不算生产就绪。 */
function environmentProviderReadinessProbe(
  provider: EnvironmentProviderPort,
  enabled: boolean
): ReadinessProbe {
  const isPlaceholder =
    provider instanceof TestEnvironmentProvider ||
    provider instanceof UnavailableEnvironmentProvider;
  return {
    name: "environment-provider",
    run: () =>
      Promise.resolve(
        !enabled
          ? { status: "ok", message: "环境数据功能已按交付范围显式关闭" }
          : isPlaceholder
          ? {
              status: "not_configured",
              message: "环境数据接口未接真实供应商（测试替身或不可用占位）"
            }
          : { status: "ok", message: "已接入环境数据供应商" }
      )
  };
}

/** 规则包探针：仅临床冻结（approved）才算就绪。 */
function rulePackageReadinessProbe(): ReadinessProbe {
  return {
    name: "rule-package",
    run: () =>
      Promise.resolve(
        DRAFT_RULE_PACKAGE.status === "approved"
          ? { status: "ok", message: "规则包已临床冻结" }
          : {
              status: "not_configured",
              message: `规则包未临床冻结（status=${DRAFT_RULE_PACKAGE.status}）`
            }
      )
  };
}

/**
 * 默认环境 Provider：测试替身适配器（本 MVP 唯一适配器）。
 * 支持用 KANGMIN_ENV_PROVIDER_MODE=fixed|unavailable|timeout
 * 控制故障模式，便于 CLI 级联调与端到端测试。
 *
 * 环境门禁：非开发环境（见 developmentFallbackAllowed）注入
 * UnavailableEnvironmentProvider，环境命令抛 provider_unavailable，
 * 绝不在 staging/production 返回测试桩固定假数据。
 */
function defaultEnvironmentProvider(
  environment: NodeJS.ProcessEnv
): EnvironmentProviderPort {
  if (!developmentFallbackAllowed(environment)) {
    return new UnavailableEnvironmentProvider();
  }
  const mode = environment.KANGMIN_ENV_PROVIDER_MODE;
  if (mode === "unavailable" || mode === "timeout") {
    return new TestEnvironmentProvider({ mode });
  }
  return new TestEnvironmentProvider();
}

/** 加密配置检查（SQLite 与 PostgreSQL doctor 共用）。 */
function encryptionDoctorCheck(environment: NodeJS.ProcessEnv): DoctorCheck {
  const keys = parseEncryptionKeys(environment.KANGMIN_ENCRYPTION_KEYS);
  const plaintextAllowed = developmentFallbackAllowed(environment);
  if (keys.length > 0) {
    return {
      name: "encryption",
      status: "ok",
      message: "已配置 AES-256-GCM 加密密钥（KANGMIN_ENCRYPTION_KEYS）"
    };
  }
  if (plaintextAllowed) {
    return {
      name: "encryption",
      status: "not_configured",
      message:
        "未配置加密密钥，使用明文开发降级（仅 local/integration 或显式 KANGMIN_ALLOW_DEV_SESSION=1）"
    };
  }
  return {
    name: "encryption",
    status: "failed",
    message: "未配置 KANGMIN_ENCRYPTION_KEYS，生产语义拒绝启动（fail-closed）"
  };
}

/** 环境数据与模型检查（两种存储后端 doctor 共用的静态部分）。 */
function staticDoctorChecks(environment: NodeJS.ProcessEnv): DoctorCheck[] {
  return [
    developmentFallbackAllowed(environment)
      ? {
          name: "environment-data",
          status: "not_configured",
          message: "环境数据接口为测试替身（后续阶段接入真实供应商）"
        }
      : {
          name: "environment-data",
          status: "not_configured",
          message:
            "环境数据供应商未配置：当前环境环境命令返回 provider_unavailable（fail-closed），待接入真实供应商"
        },
    environment.KANGMIN_DEEPSEEK_API_KEY || environment.KANGMIN_QWEN_API_KEY
      ? {
          name: "model",
          status: "ok",
          message: [
            environment.KANGMIN_DEEPSEEK_API_KEY ? "DeepSeek 问卷候选提取" : null,
            environment.KANGMIN_QWEN_API_KEY ? "通义千问知识问答/方案转译/追问" : null
          ].filter((value): value is string => value !== null).join("；")
        }
      : {
          name: "model",
          status: "not_configured",
          message: "未配置模型 API 密钥，对话将降级为结构化问答或固定模板"
        }
  ];
}

function databaseDoctorCheck(migrations: readonly string[]): DoctorCheck {
  return {
    name: "database",
    status: migrations.length === 0 ? "failed" : "ok",
    message:
      migrations.length === 0
        ? "数据库没有任何已应用迁移"
        : `已应用迁移：${migrations.join(", ")}`
  };
}

/** PostgreSQL 后端 doctor：与 SQLite 版相同的检查集，数据库探针走 PG。 */
export async function runPgPatientDoctor(
  database: KangminPgDatabase,
  environment: NodeJS.ProcessEnv
): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [encryptionDoctorCheck(environment)];
  try {
    checks.push(databaseDoctorCheck(await appliedPgMigrationVersions(database)));
  } catch {
    // 与 SQLite 版一致：固定文案，不拼接底层错误细节（评审 B P2-12b）。
    checks.push({
      name: "database",
      status: "failed",
      message: "数据库打开或迁移失败，请检查存储与密钥配置"
    });
  }
  checks.push(...staticDoctorChecks(environment));
  return {
    checks,
    healthy: checks.every((check) => check.status !== "failed")
  };
}

/** doctor 只检查连接与配置状态，不修改任何配置。 */
export function runPatientDoctor(
  databasePath: string,
  environment: NodeJS.ProcessEnv
): DoctorReport {
  const checks: DoctorCheck[] = [encryptionDoctorCheck(environment)];

  // 密钥缺失时不阻止诊断数据库本身：以明文端口尝试打开，迁移中的
  // 加密回填在检测到旧明文数据时仍会抛 config_missing（安全优先）。
  let encryption: EncryptionPort | undefined;
  try {
    encryption = resolveEncryption(environment);
  } catch {
    encryption = undefined;
  }

  try {
    const database = new KangminDatabase(databasePath, encryption);
    try {
      checks.push(databaseDoctorCheck(appliedMigrationVersions(database)));
    } finally {
      database.close();
    }
  } catch {
    // 事务与卫生残留批 P2-12b：doctor 报告固定文案，不拼接底层
    // error.message（可能含绝对路径/内部实现细节）。
    checks.push({
      name: "database",
      status: "failed",
      message: "数据库打开或迁移失败，请检查存储与密钥配置"
    });
  }

  checks.push(...staticDoctorChecks(environment));

  return {
    checks,
    healthy: checks.every((check) => check.status !== "failed")
  };
}

export function createApplication(
  databasePath: string,
  options: ApplicationOptions = {}
): KangminApplication {
  return createApplicationWithOps(databasePath, options).application;
}

/**
 * 启动时 best-effort 清理过期匿名会话（issue-155 匿名 24h 保留期执行）：
 * 失败只记 stderr，绝不阻断启动。
 */
function cleanupExpiredAnonymousSessions(
  repository: ConversationRepository
): void {
  void repository
    .deleteExpiredAnonymousSessions(new Date().toISOString())
    .catch((error: unknown) => {
      console.error(
        "过期匿名会话启动清理失败（不影响启动）",
        error instanceof Error ? error.message : String(error)
      );
    });
}

/**
 * 带运维语义的应用装配：除应用实例外，同时返回 /ready 就绪探针
 * （探针闭包复用同一数据库连接，不另开连接池）。
 */
export function createApplicationWithOps(
  databasePath: string,
  options: ApplicationOptions = {}
): ApplicationWithOps {
  const environment =
    options.appEnvironment === undefined
      ? process.env
      : { ...process.env, KANGMIN_APP_ENV: options.appEnvironment };
  const environmentProvider =
    options.environmentProvider ?? defaultEnvironmentProvider(environment);
  // 生产存储 fail-closed：仅真实环境驱动时校验；options.appEnvironment
  // 是文档化的测试装配钩子（显式注入视为测试，不套用生产存储门槛）。
  if (options.appEnvironment === undefined) {
    assertProductionStorage(environment, { environmentProvider });
  }
  const encryption = options.encryption ?? resolveEncryption(environment);
  const modelAdapter = new DeepSeekModelAdapter({
    apiKey: environment.KANGMIN_DEEPSEEK_API_KEY,
    model: environment.KANGMIN_DEEPSEEK_MODEL
  });
  const extraction: ModelExtractionPort = options.extraction ?? modelAdapter;
  const explanation: ModelExplanationPort = options.explanation ?? modelAdapter;
  const qwenDialogue = new QwenPlanDialogueAdapter({
    apiKey: environment.KANGMIN_QWEN_API_KEY,
    model: environment.KANGMIN_QWEN_MODEL
  });
  const planDialogue: PlanDialoguePort = options.planDialogue ?? qwenDialogue;
  const knowledgeAnswer = options.knowledgeAnswer ?? qwenDialogue;
  const knowledgeEmbedding =
    options.knowledgeEmbedding ??
    new DashscopeEmbeddingAdapter({
      apiKey: environment.KANGMIN_QWEN_API_KEY,
      model: environment.KANGMIN_EMBEDDING_MODEL,
      baseUrl: environment.KANGMIN_EMBEDDING_BASE_URL
    });
  // 对象存储（媒体交付链 issue-151）：与管理端同一解析规则，本地后端
  // 默认指向管理端素材目录（KANGMIN_ADMIN_MEDIA_DIR 或 <db目录>/admin-media），
  // HTTP 媒体路由经 browse 服务读取已发布内容引用的字节。
  const mediaDirectory =
    options.mediaDirectory ??
    process.env.KANGMIN_ADMIN_MEDIA_DIR ??
    defaultMediaDirectory(databasePath);
  const objectStorage = resolveObjectStorage(options, mediaDirectory);
  const staticProbes = {
    encryption: encryptionReadinessProbe(environment),
    environmentProvider: environmentProviderReadinessProbe(
      environmentProvider,
      environment.KANGMIN_ENVIRONMENT_ENABLED !== "0"
    ),
    rulePackage: rulePackageReadinessProbe()
  };

  const databaseUrl = resolveDatabaseUrl(options, environment);
  if (databaseUrl !== undefined) {
    const database = new KangminPgDatabase(databaseUrl);
    const readinessProbes: PatientReadinessProbes = {
      database: pgDatabaseReadinessProbe(database),
      ...staticProbes
    };
    const sessions = new SessionService(new PgSessionRepository(database));
    // 生效规则包（测试可注入 candidate 模拟未冻结）：浏览门禁与内核同源。
    const rulePackage = options.rulePackage ?? DRAFT_RULE_PACKAGE;
    // 内核正式路径：生效规则包非 approved（如 candidate）时阻断输出方案；
    // 注册表数据源接通统一方案表 agent_plans，管理端启用且浏览门禁放开后可见。
    const planRegistry: PlanRegistryPort =
      options.planRegistry ?? new PgPlanRegistry(database);
    const kernel = new ClinicalRuleKernel(rulePackage, planRegistry);
    const accountRepository = new PgAccountRepository(database);
    const conversationRepository = new PgConversationRepository(database);
    const knowledgeRetrieval =
      options.planKnowledgeRetrieval ?? new PgKnowledgeRetrieval(database, knowledgeEmbedding);
    // consent 门禁（issue-155）：record 写入前置 + 绑定保存共用。
    const consentGate = new ConsentGateAdapter(accountRepository);
    const conversations = new ConversationService(
      conversationRepository,
      kernel,
      extraction,
      explanation,
      encryption,
      consentGate,
      planDialogue,
      knowledgeRetrieval
    );
    cleanupExpiredAnonymousSessions(conversationRepository);
    return {
      application: new KangminApplication(
        sessions,
        new PgRecordRepository(database, encryption),
        // 评审 P1-12：PG 路径与 SQLite 同一派生——规则包 approved 即放开
        // 患者浏览（生产 browse 不再恒关）。
        new PgContentReadRepository(database, {
          planBrowseEnabled: rulePackage.status === "approved"
        }),
        new PgAgentRepository(database),
        new AccountService(accountRepository, sessions),
        environmentProvider,
        new PgEnvironmentCacheRepository(database),
        conversations,
        consentGate,
        () => {
          void database.close();
        },
        () => runPgPatientDoctor(database, environment),
        objectStorage,
        new KnowledgeQaService(knowledgeRetrieval, knowledgeAnswer)
      ),
      readinessProbes
    };
  }

  const database = new KangminDatabase(databasePath, encryption);
  const readinessProbes: PatientReadinessProbes = {
    database: sqliteDatabaseReadinessProbe(database),
    ...staticProbes
  };
  const sessions = new SessionService(new SqliteSessionRepository(database));
  // 生效规则包（测试可注入 candidate 模拟未冻结）：浏览门禁与内核同源。
  const rulePackage = options.rulePackage ?? DRAFT_RULE_PACKAGE;
  // 内核正式路径：生效规则包非 approved（如 candidate）时阻断输出方案；
  // 注册表数据源接通统一方案表 agent_plans，管理端启用且浏览门禁放开后可见。
  const planRegistry: PlanRegistryPort =
    options.planRegistry ?? new SqlitePlanRegistry(database);
  const kernel = new ClinicalRuleKernel(rulePackage, planRegistry);
  const accountRepository = new SqliteAccountRepository(database);
  const conversationRepository = new SqliteConversationRepository(database);
  const knowledgeRetrieval =
    options.planKnowledgeRetrieval ?? new SqliteKnowledgeRetrieval(database, knowledgeEmbedding);
  // consent 门禁（issue-155）：record 写入前置 + 绑定保存共用。
  const consentGate = new ConsentGateAdapter(accountRepository);
  const conversations = new ConversationService(
    conversationRepository,
    kernel,
    extraction,
    explanation,
    encryption,
    consentGate,
    planDialogue,
    knowledgeRetrieval
  );
  cleanupExpiredAnonymousSessions(conversationRepository);

  return {
    application: new KangminApplication(
      sessions,
      new SqliteRecordRepository(database, encryption),
      // 方案浏览门禁（设计 §17 患者侧门禁）：与规则包冻结状态同源
      // （评审 P1-12）——生效规则包 approved（默认 clinical-rules-v3 已启用）
      // 即放开，不再读 KANGMIN_PLAN_BROWSE_ENABLED。
      new SqliteContentReadRepository(database, {
        planBrowseEnabled: rulePackage.status === "approved"
      }),
      new SqliteAgentRepository(database),
      new AccountService(accountRepository, sessions),
      environmentProvider,
      new SqliteEnvironmentCacheRepository(database),
      conversations,
      consentGate,
      () => {
        database.close();
      },
      () => Promise.resolve(runPatientDoctor(databasePath, environment)),
      objectStorage,
      new KnowledgeQaService(knowledgeRetrieval, knowledgeAnswer)
    ),
    readinessProbes
  };
}

/**
 * 密钥来源（组合根策略）：
 * 1. KANGMIN_ENCRYPTION_KEYS（"v1:<base64>,v2:<base64>" 密钥链，首个为
 *    当前版本）→ AesGcmEncryption；格式非法同样抛 config_missing，不降级。
 * 2. 未配置密钥时，仅 local/integration（KANGMIN_APP_ENV）或显式
 *    KANGMIN_ALLOW_DEV_SESSION=1 允许 PlaintextEncryption 明文降级，
 *    数据带 plaintext-dev 版本，生产语义下读取会被拒绝。
 * 3. 其余任何环境（含默认）→ 抛 config_missing（退出码 5），
 *    绝不在缺少密钥时明文启动。
 */
export function resolveEncryption(
  environment: NodeJS.ProcessEnv
): EncryptionPort {
  const keys = parseEncryptionKeys(environment.KANGMIN_ENCRYPTION_KEYS);
  if (keys.length > 0) {
    return new AesGcmEncryption(keys);
  }
  // 显式 staging/production 时 KANGMIN_ALLOW_DEV_SESSION 不生效：
  // 即使误设开发会话开关，生产环境也不得明文降级（fail-closed）。
  if (developmentFallbackAllowed(environment)) {
    return new PlaintextEncryption();
  }
  throw new DomainError(
    "config_missing",
    "未配置 KANGMIN_ENCRYPTION_KEYS，无法安全启动；本地开发请设置 KANGMIN_APP_ENV=local 或 KANGMIN_ALLOW_DEV_SESSION=1"
  );
}
