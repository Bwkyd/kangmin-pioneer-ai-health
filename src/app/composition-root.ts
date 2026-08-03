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
 * 模型端口默认 DeepSeek 适配器：未配置 KANGMIN_DEEPSEEK_API_KEY 时
 * 抛 provider_unavailable，对话降级为结构化问答；测试可注入替身。
 *
 * 环境 Provider 门禁（fail-closed，与加密降级同一谓词）：测试替身仅在
 * KANGMIN_APP_ENV 为 local/integration，或显式 KANGMIN_ALLOW_DEV_SESSION=1
 * （且非 staging/production）时启用；其余环境（含 CLI 默认未设
 * KANGMIN_APP_ENV）注入 UnavailableEnvironmentProvider，环境命令抛
 * provider_unavailable，绝不返回测试桩固定假数据。
 *
 * 方案浏览开关：KANGMIN_PLAN_BROWSE_ENABLED=1 时注入
 * planBrowseEnabled=true（默认 false，临床规则包冻结前不放开）。
 */

import { DomainError } from "../kernel/errors.js";
import type { EncryptionPort } from "../kernel/encryption.js";
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
import { AccountService } from "../modules/account/account-service.js";
import { SessionService } from "../modules/account/session-service.js";
import { ConversationService } from "../modules/agent/conversation-service.js";
import type {
  ModelExplanationPort,
  ModelExtractionPort
} from "../modules/agent/model-ports.js";
import { ClinicalRuleKernel } from "../modules/clinical-rules/clinical-rule-kernel.js";
import type { PlanRegistryPort } from "../modules/clinical-rules/contracts.js";
import { DRAFT_RULE_PACKAGE } from "../modules/clinical-rules/rule-package.js";
import type { EnvironmentProviderPort } from "../modules/environment/environment-ports.js";

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
  /** 方案注册表端口；默认无任何已批准方案（规则包未冻结）。 */
  planRegistry?: PlanRegistryPort | undefined;
  /** 显式覆盖 KANGMIN_APP_ENV（测试用）；未提供时读环境变量。 */
  appEnvironment?: AppEnvironment | undefined;
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

/** doctor 只检查连接与配置状态，不修改任何配置。 */
export function runPatientDoctor(
  databasePath: string,
  environment: NodeJS.ProcessEnv
): DoctorReport {
  const checks: DoctorCheck[] = [];

  const keys = parseEncryptionKeys(environment.KANGMIN_ENCRYPTION_KEYS);
  const plaintextAllowed = developmentFallbackAllowed(environment);
  if (keys.length > 0) {
    checks.push({
      name: "encryption",
      status: "ok",
      message: "已配置 AES-256-GCM 加密密钥（KANGMIN_ENCRYPTION_KEYS）"
    });
  } else if (plaintextAllowed) {
    checks.push({
      name: "encryption",
      status: "not_configured",
      message:
        "未配置加密密钥，使用明文开发降级（仅 local/integration 或显式 KANGMIN_ALLOW_DEV_SESSION=1）"
    });
  } else {
    checks.push({
      name: "encryption",
      status: "failed",
      message:
        "未配置 KANGMIN_ENCRYPTION_KEYS，生产语义拒绝启动（fail-closed）"
    });
  }

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
      const migrations = appliedMigrationVersions(database);
      checks.push({
        name: "database",
        status: migrations.length === 0 ? "failed" : "ok",
        message:
          migrations.length === 0
            ? "数据库没有任何已应用迁移"
            : `已应用迁移：${migrations.join(", ")}`
      });
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

  if (developmentFallbackAllowed(environment)) {
    checks.push({
      name: "environment-data",
      status: "not_configured",
      message: "环境数据接口为测试替身（后续阶段接入真实供应商）"
    });
  } else {
    checks.push({
      name: "environment-data",
      status: "not_configured",
      message:
        "环境数据供应商未配置：当前环境环境命令返回 provider_unavailable（fail-closed），待接入真实供应商"
    });
  }

  if (environment.KANGMIN_DEEPSEEK_API_KEY) {
    checks.push({
      name: "model",
      status: "ok",
      message: "已配置模型 API 密钥（KANGMIN_DEEPSEEK_API_KEY）"
    });
  } else {
    checks.push({
      name: "model",
      status: "not_configured",
      message: "未配置模型 API 密钥，自由对话将降级为结构化问答"
    });
  }

  return {
    checks,
    healthy: checks.every((check) => check.status !== "failed")
  };
}

export function createApplication(
  databasePath: string,
  options: ApplicationOptions = {}
): KangminApplication {
  const environment =
    options.appEnvironment === undefined
      ? process.env
      : { ...process.env, KANGMIN_APP_ENV: options.appEnvironment };
  const encryption = options.encryption ?? resolveEncryption(environment);
  const database = new KangminDatabase(databasePath, encryption);
  const sessions = new SessionService(new SqliteSessionRepository(database));
  const environmentProvider =
    options.environmentProvider ?? defaultEnvironmentProvider(environment);

  // 规则包未冻结：内核正式路径仍由 candidate 状态阻断（不输出方案）；
  // 注册表数据源接通统一方案表 agent_plans，供模拟测试与冻结后的正式评估使用。
  const planRegistry: PlanRegistryPort =
    options.planRegistry ?? new SqlitePlanRegistry(database);
  const kernel = new ClinicalRuleKernel(DRAFT_RULE_PACKAGE, planRegistry);
  const modelAdapter = new DeepSeekModelAdapter({
    apiKey: process.env.KANGMIN_DEEPSEEK_API_KEY
  });
  const extraction: ModelExtractionPort = options.extraction ?? modelAdapter;
  const explanation: ModelExplanationPort = options.explanation ?? modelAdapter;
  const conversations = new ConversationService(
    new SqliteConversationRepository(database),
    kernel,
    extraction,
    explanation,
    encryption
  );

  return new KangminApplication(
    sessions,
    new SqliteRecordRepository(database, encryption),
    // 方案浏览开关（设计 §17 患者侧门禁）：默认 false，临床规则包冻结
    // 前不放开；显式 KANGMIN_PLAN_BROWSE_ENABLED=1 时注入 true。
    new SqliteContentReadRepository(database, {
      planBrowseEnabled: environment.KANGMIN_PLAN_BROWSE_ENABLED === "1"
    }),
    new SqliteAgentRepository(database),
    new AccountService(new SqliteAccountRepository(database), sessions),
    environmentProvider,
    new SqliteEnvironmentCacheRepository(database),
    conversations,
    () => {
      database.close();
    },
    () => Promise.resolve(runPatientDoctor(databasePath, environment))
  );
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
