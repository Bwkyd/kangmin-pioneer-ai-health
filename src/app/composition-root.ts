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
 */

import { DomainError } from "../kernel/errors.js";
import type { EncryptionPort } from "../kernel/encryption.js";
import { KangminApplication } from "./application.js";
import { KangminDatabase } from "../infrastructure/database.js";
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
import { SqliteRecordRepository } from "../infrastructure/sqlite-record-repository.js";
import { SqliteSessionRepository } from "../infrastructure/sqlite-session-repository.js";
import { TestEnvironmentProvider } from "../infrastructure/test-environment-provider.js";
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
 * 默认环境 Provider：测试替身适配器（本 MVP 唯一适配器）。
 * 支持用 KANGMIN_ENV_PROVIDER_MODE=fixed|unavailable|timeout
 * 控制故障模式，便于 CLI 级联调与端到端测试。
 */
function defaultEnvironmentProvider(): EnvironmentProviderPort {
  const mode = process.env.KANGMIN_ENV_PROVIDER_MODE;
  if (mode === "unavailable" || mode === "timeout") {
    return new TestEnvironmentProvider({ mode });
  }
  return new TestEnvironmentProvider();
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
    options.environmentProvider ?? defaultEnvironmentProvider();

  const planRegistry: PlanRegistryPort = options.planRegistry ?? {
    // 规则包未冻结，没有任何已批准方案；候选方案不得进入正式路径。
    findApprovedPlan: () => null
  };
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
    new SqliteContentReadRepository(database),
    new SqliteAgentRepository(database),
    new AccountService(new SqliteAccountRepository(database), sessions),
    environmentProvider,
    new SqliteEnvironmentCacheRepository(database),
    conversations,
    () => {
      database.close();
    }
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
  const appEnvironment = environment.KANGMIN_APP_ENV;
  // 显式 staging/production 时 KANGMIN_ALLOW_DEV_SESSION 不生效：
  // 即使误设开发会话开关，生产环境也不得明文降级（fail-closed）。
  if (
    appEnvironment === "local" ||
    appEnvironment === "integration" ||
    (environment.KANGMIN_ALLOW_DEV_SESSION === "1" &&
      appEnvironment !== "staging" &&
      appEnvironment !== "production")
  ) {
    return new PlaintextEncryption();
  }
  throw new DomainError(
    "config_missing",
    "未配置 KANGMIN_ENCRYPTION_KEYS，无法安全启动；本地开发请设置 KANGMIN_APP_ENV=local 或 KANGMIN_ALLOW_DEV_SESSION=1"
  );
}
