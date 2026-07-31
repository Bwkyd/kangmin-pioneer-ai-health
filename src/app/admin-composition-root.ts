import { accessSync, constants } from "node:fs";
import { dirname, join } from "node:path";

import { KangminAdminApplication, type DoctorCheck, type DoctorReport } from "./admin-application.js";
import { resolveEncryption } from "./composition-root.js";
import { KangminDatabase, appliedMigrationVersions } from "../infrastructure/database.js";
import { SqliteAdminAccountRepository } from "../infrastructure/sqlite-admin-account-repository.js";
import { SqliteAdminSessionRepository } from "../infrastructure/sqlite-admin-session-repository.js";
import { SqliteAgentAdminRepository } from "../infrastructure/sqlite-agent-admin-repository.js";
import { SqliteContentAdminRepository } from "../infrastructure/sqlite-content-admin-repository.js";
import { SqliteContentAuxRepository } from "../infrastructure/sqlite-content-aux-repository.js";
import { SqliteAuditRepository } from "../infrastructure/sqlite-audit-repository.js";
import { SqliteUserAdminRepository } from "../infrastructure/sqlite-user-admin-repository.js";
import { BuiltinSyndromeRegistry } from "../infrastructure/syndrome-registry.js";

function defaultMediaDirectory(databasePath: string): string {
  return join(dirname(databasePath), "admin-media");
}

/** doctor 只检查连接状态，不修改任何配置。 */
function doctorChecks(
  database: KangminDatabase,
  mediaDirectory: string
): DoctorReport {
  const checks: DoctorCheck[] = [];

  const migrations = appliedMigrationVersions(database);
  checks.push({
    name: "database",
    status: migrations.length === 0 ? "failed" : "ok",
    message:
      migrations.length === 0
        ? "数据库没有任何已应用迁移"
        : `已应用迁移：${migrations.join(", ")}`
  });

  const mediaDirectoryStatus: DoctorCheck["status"] = (() => {
    try {
      accessSync(mediaDirectory, constants.R_OK | constants.W_OK);
      return "ok";
    } catch {
      return "failed";
    }
  })();
  checks.push({
    name: "media-storage",
    status: mediaDirectoryStatus,
    message:
      mediaDirectoryStatus === "ok"
        ? `素材目录可读写：${mediaDirectory}`
        : `素材目录不可读写：${mediaDirectory}`
  });

  const accounts = database.connection.prepare(
    "SELECT COUNT(*) AS count FROM admin_accounts"
  ).get() as unknown as { count: number };
  checks.push({
    name: "admin-accounts",
    status: accounts.count > 0 ? "ok" : "not_configured",
    message:
      accounts.count > 0
        ? `已有 ${accounts.count} 个管理员账号`
        : "尚无管理员账号，需要先执行 auth admins add --role owner 完成引导"
  });

  const model = database.connection.prepare(`
    SELECT model_name, last_test_status FROM agent_model_config WHERE id = 1
  `).get() as unknown as { model_name: string; last_test_status: string | null } | undefined;
  checks.push({
    name: "model",
    status:
      model === undefined || model.model_name === ""
        ? "not_configured"
        : model.last_test_status === null
          ? "ok"
          : model.last_test_status === "capability_unavailable"
            ? "not_configured"
            : "failed",
    message:
      model === undefined || model.model_name === ""
        ? "模型尚未配置"
        : `模型已配置（${model.model_name}），最近测试：${model.last_test_status ?? "未测试"}`
  });

  const failedKnowledge = database.connection.prepare(`
    SELECT COUNT(*) AS count FROM agent_knowledge_items WHERE status = 'index_failed'
  `).get() as unknown as { count: number };
  checks.push({
    name: "knowledge-index",
    status: failedKnowledge.count > 0 ? "failed" : "ok",
    message:
      failedKnowledge.count > 0
        ? `${failedKnowledge.count} 条知识索引失败`
        : "知识索引无失败"
  });

  checks.push({
    name: "environment-data",
    status: "not_configured",
    message: "环境数据接口尚未接入（后续阶段提供）"
  });

  return {
    checks,
    healthy: checks.every((check) => check.status !== "failed")
  };
}

export function createAdminApplication(
  path: string,
  options: { mediaDirectory?: string } = {}
): KangminAdminApplication {
  // 与患者端一致的密钥策略（fail-closed）：KANGMIN_ENCRYPTION_KEYS → AES；
  // local/integration 或显式 KANGMIN_ALLOW_DEV_SESSION=1 → 明文开发降级；
  // 其余环境 → config_missing。API Key 与旧库回填依赖该端口。
  const encryption = resolveEncryption(process.env);
  const database = new KangminDatabase(path, encryption);
  const mediaDirectory = options.mediaDirectory ?? defaultMediaDirectory(path);
  const sessionRepository = new SqliteAdminSessionRepository(database);
  const accountRepository = new SqliteAdminAccountRepository(database);
  const contentRepository = new SqliteContentAdminRepository(database);
  const auxRepository = new SqliteContentAuxRepository(database);
  const agentRepository = new SqliteAgentAdminRepository(database, encryption);
  const userRepository = new SqliteUserAdminRepository(database);
  const auditRepository = new SqliteAuditRepository(database);
  return new KangminAdminApplication(
    sessionRepository,
    accountRepository,
    contentRepository,
    auxRepository,
    agentRepository,
    new BuiltinSyndromeRegistry(),
    userRepository,
    mediaDirectory,
    auditRepository,
    () => {
      database.close();
    },
    () => Promise.resolve(doctorChecks(database, mediaDirectory))
  );
}
