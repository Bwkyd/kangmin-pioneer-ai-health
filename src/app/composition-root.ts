import { KangminApplication } from "./application.js";
import { KangminDatabase } from "../infrastructure/database.js";
import { SqliteRecordRepository } from "../infrastructure/sqlite-record-repository.js";
import { SqliteSessionRepository } from "../infrastructure/sqlite-session-repository.js";
import { SqliteContentReadRepository } from "../infrastructure/sqlite-content-read-repository.js";
import { SqliteAgentRepository } from "../infrastructure/sqlite-agent-repository.js";
import {
  AesGcmEncryption,
  parseEncryptionKeys,
  PlaintextEncryption
} from "../infrastructure/aes-gcm-encryption.js";
import { DomainError } from "../kernel/errors.js";
import type { EncryptionPort } from "../kernel/encryption.js";

export interface ApplicationOptions {
  /** 显式注入加密端口；未提供时按环境解析（见 resolveEncryption）。 */
  encryption?: EncryptionPort;
}

export function createApplication(
  databasePath: string,
  options: ApplicationOptions = {}
): KangminApplication {
  const encryption = options.encryption ?? resolveEncryption(process.env);
  const database = new KangminDatabase(databasePath, encryption);
  return new KangminApplication(
    new SqliteSessionRepository(database),
    new SqliteRecordRepository(database, encryption),
    new SqliteContentReadRepository(database),
    new SqliteAgentRepository(database),
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
function resolveEncryption(environment: NodeJS.ProcessEnv): EncryptionPort {
  const keys = parseEncryptionKeys(environment.KANGMIN_ENCRYPTION_KEYS);
  if (keys.length > 0) {
    return new AesGcmEncryption(keys);
  }
  const appEnvironment = environment.KANGMIN_APP_ENV;
  const allowDevelopmentSession =
    environment.KANGMIN_ALLOW_DEV_SESSION === "1";
  if (
    appEnvironment === "local" ||
    appEnvironment === "integration" ||
    allowDevelopmentSession
  ) {
    return new PlaintextEncryption();
  }
  throw new DomainError(
    "config_missing",
    "未配置 KANGMIN_ENCRYPTION_KEYS，无法安全启动；本地开发请设置 KANGMIN_APP_ENV=local 或 KANGMIN_ALLOW_DEV_SESSION=1"
  );
}
