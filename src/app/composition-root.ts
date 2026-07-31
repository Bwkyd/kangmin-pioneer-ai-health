/**
 * 组合根：唯一允许把基础设施/适配器注入领域模块的地方。
 *
 * 加密密钥策略（与交付基线一致）：
 * - 配置了 KANGMIN_ENCRYPTION_KEYS → AES-256-GCM（首个条目为当前版本）；
 * - 未配置密钥且 KANGMIN_APP_ENV 为 local/integration → 明文开发实现
 *   （生产语义上不可用于正式数据）；
 * - 未配置密钥且 KANGMIN_APP_ENV 为 staging/production → 启动失败
 *   config_missing（fail-closed）。
 *
 * 模型端口默认 DeepSeek 适配器：未配置 KANGMIN_DEEPSEEK_API_KEY 时
 * 抛 provider_unavailable，对话降级为结构化问答；测试可注入替身。
 */

import { DomainError } from "../kernel/errors.js";
import type { EncryptionPort } from "../kernel/encryption.js";
import { KangminDatabase } from "../infrastructure/database.js";
import { SqliteRecordRepository } from "../infrastructure/sqlite-record-repository.js";
import { SqliteSessionRepository } from "../infrastructure/sqlite-session-repository.js";
import { SqliteContentReadRepository } from "../infrastructure/sqlite-content-read-repository.js";
import { SqliteAgentRepository } from "../infrastructure/sqlite-agent-repository.js";
import { SqliteConversationRepository } from "../infrastructure/sqlite-conversation-repository.js";
import {
  AesGcmEncryption,
  parseEncryptionKeys,
  PlaintextEncryption
} from "../infrastructure/aes-gcm-encryption.js";
import { DeepSeekModelAdapter } from "../infrastructure/deepseek-model-adapter.js";
import { ClinicalRuleKernel } from "../modules/clinical-rules/clinical-rule-kernel.js";
import { DRAFT_RULE_PACKAGE } from "../modules/clinical-rules/rule-package.js";
import type { PlanRegistryPort } from "../modules/clinical-rules/contracts.js";
import { ConversationService } from "../modules/agent/conversation-service.js";
import type {
  ModelExplanationPort,
  ModelExtractionPort
} from "../modules/agent/model-ports.js";
import { KangminApplication } from "./application.js";

export type AppEnvironment = "local" | "integration" | "staging" | "production";

export interface CreateApplicationOptions {
  encryption?: EncryptionPort | undefined;
  extraction?: ModelExtractionPort | undefined;
  explanation?: ModelExplanationPort | undefined;
  planRegistry?: PlanRegistryPort | undefined;
  appEnvironment?: AppEnvironment | undefined;
}

/** 未显式声明环境时按本地开发处理（保持既有调用方与测试兼容）。 */
function resolveEnvironment(value: string | undefined): AppEnvironment {
  return value === "local" ||
    value === "integration" ||
    value === "staging" ||
    value === "production"
    ? value
    : "local";
}

function resolveEncryption(
  environment: AppEnvironment,
  keysValue: string | undefined
): EncryptionPort {
  const keys = parseEncryptionKeys(keysValue);
  if (keys.length > 0) {
    return new AesGcmEncryption(keys);
  }
  if (environment === "local" || environment === "integration") {
    return new PlaintextEncryption();
  }
  throw new DomainError(
    "config_missing",
    `环境 ${environment} 必须配置 KANGMIN_ENCRYPTION_KEYS 才能启动`
  );
}

export function createApplication(
  databasePath: string,
  options: CreateApplicationOptions = {}
): KangminApplication {
  const environment =
    options.appEnvironment ??
    resolveEnvironment(process.env.KANGMIN_APP_ENV);
  const encryption =
    options.encryption ??
    resolveEncryption(environment, process.env.KANGMIN_ENCRYPTION_KEYS);

  const database = new KangminDatabase(databasePath);

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
    new SqliteSessionRepository(database),
    new SqliteRecordRepository(database),
    new SqliteContentReadRepository(database),
    new SqliteAgentRepository(database),
    conversations,
    () => {
      database.close();
    }
  );
}
