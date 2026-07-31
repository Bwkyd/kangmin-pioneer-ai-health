import { KangminApplication } from "./application.js";
import { KangminDatabase } from "../infrastructure/database.js";
import { SqliteRecordRepository } from "../infrastructure/sqlite-record-repository.js";
import { SqliteSessionRepository } from "../infrastructure/sqlite-session-repository.js";
import { SqliteContentReadRepository } from "../infrastructure/sqlite-content-read-repository.js";
import { SqliteEnvironmentCacheRepository } from "../infrastructure/sqlite-environment-cache-repository.js";
import { TestEnvironmentProvider } from "../infrastructure/test-environment-provider.js";
import type { EnvironmentProviderPort } from "../modules/environment/environment-ports.js";
import { SqliteAgentRepository } from "../infrastructure/sqlite-agent-repository.js";

export interface ApplicationOptions {
  /** 环境 Provider 注入点（测试用）；默认使用测试替身适配器。 */
  environmentProvider?: EnvironmentProviderPort | undefined;
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
  const database = new KangminDatabase(databasePath);
  const environmentProvider =
    options.environmentProvider ?? defaultEnvironmentProvider();
  return new KangminApplication(
    new SqliteSessionRepository(database),
    new SqliteRecordRepository(database),
    new SqliteContentReadRepository(database),
    new SqliteAgentRepository(database),
    environmentProvider,
    new SqliteEnvironmentCacheRepository(database),
    () => {
      database.close();
    }
  );
}
