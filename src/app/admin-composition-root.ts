import { accessSync, constants } from "node:fs";
import { dirname, join } from "node:path";

import { KangminAdminApplication, type DoctorCheck, type DoctorReport } from "./admin-application.js";
import { resolveDatabaseUrl, resolveEncryption } from "./composition-root.js";
import { KangminDatabase, appliedMigrationVersions } from "../infrastructure/database.js";
import {
  KangminPgDatabase,
  appliedPgMigrationVersions
} from "../infrastructure/postgres/pg-database.js";
import { PgAdminAccountRepository } from "../infrastructure/postgres/pg-admin-account-repository.js";
import { PgAdminSessionRepository } from "../infrastructure/postgres/pg-admin-session-repository.js";
import { PgAgentAdminRepository } from "../infrastructure/postgres/pg-agent-admin-repository.js";
import { PgAuditRepository } from "../infrastructure/postgres/pg-audit-repository.js";
import { PgContentAdminRepository } from "../infrastructure/postgres/pg-content-admin-repository.js";
import { PgContentAuxRepository } from "../infrastructure/postgres/pg-content-aux-repository.js";
import { PgUserAdminRepository } from "../infrastructure/postgres/pg-user-admin-repository.js";
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

/** 素材目录检查（SQLite 与 PostgreSQL doctor 共用；固定文案，不输出绝对路径）。 */
function mediaStorageCheck(mediaDirectory: string): DoctorCheck {
  const status: DoctorCheck["status"] = (() => {
    try {
      accessSync(mediaDirectory, constants.R_OK | constants.W_OK);
      return "ok";
    } catch {
      return "failed";
    }
  })();
  // 事务与卫生残留批 P2-12b：固定文案，不输出素材目录绝对路径。
  return {
    name: "media-storage",
    status,
    message:
      status === "ok"
        ? "素材目录可读写"
        : "素材目录不可读写（检查权限与磁盘空间）"
  };
}

function databaseMigrationsCheck(migrations: readonly string[]): DoctorCheck {
  return {
    name: "database",
    status: migrations.length === 0 ? "failed" : "ok",
    message:
      migrations.length === 0
        ? "数据库没有任何已应用迁移"
        : `已应用迁移：${migrations.join(", ")}`
  };
}

function adminAccountsCheck(count: number): DoctorCheck {
  return {
    name: "admin-accounts",
    status: count > 0 ? "ok" : "not_configured",
    message:
      count > 0
        ? `已有 ${count} 个管理员账号`
        : "尚无管理员账号，需要先执行 auth admins add --role owner 完成引导"
  };
}

function modelConfigCheck(
  model: { model_name: string; last_test_status: string | null } | undefined
): DoctorCheck {
  return {
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
  };
}

function knowledgeIndexCheck(failedCount: number): DoctorCheck {
  return {
    name: "knowledge-index",
    status: failedCount > 0 ? "failed" : "ok",
    message:
      failedCount > 0 ? `${failedCount} 条知识索引失败` : "知识索引无失败"
  };
}

const ENVIRONMENT_DATA_CHECK: DoctorCheck = {
  name: "environment-data",
  status: "not_configured",
  message: "环境数据接口尚未接入（后续阶段提供）"
};

interface CountRow {
  count: number;
}

interface ModelConfigRow {
  model_name: string;
  last_test_status: string | null;
}

/** PostgreSQL 后端 doctor：检查集与 SQLite 版一致，探针走 PG。 */
async function pgDoctorChecks(
  database: KangminPgDatabase,
  mediaDirectory: string
): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [
    databaseMigrationsCheck(await appliedPgMigrationVersions(database)),
    mediaStorageCheck(mediaDirectory)
  ];

  const accounts = await database.query<CountRow>(
    "SELECT COUNT(*)::int AS count FROM admin_accounts"
  );
  checks.push(adminAccountsCheck(accounts.rows[0]?.count ?? 0));

  const model = await database.query<ModelConfigRow>(`
    SELECT model_name, last_test_status FROM agent_model_config WHERE id = 1
  `);
  checks.push(modelConfigCheck(model.rows[0]));

  const failedKnowledge = await database.query<CountRow>(`
    SELECT COUNT(*)::int AS count FROM agent_knowledge_items WHERE status = 'index_failed'
  `);
  checks.push(knowledgeIndexCheck(failedKnowledge.rows[0]?.count ?? 0));

  checks.push(ENVIRONMENT_DATA_CHECK);

  return {
    checks,
    healthy: checks.every((check) => check.status !== "failed")
  };
}

/** doctor 只检查连接状态，不修改任何配置。 */
function doctorChecks(
  database: KangminDatabase,
  mediaDirectory: string
): DoctorReport {
  const checks: DoctorCheck[] = [
    databaseMigrationsCheck(appliedMigrationVersions(database)),
    mediaStorageCheck(mediaDirectory)
  ];

  const accounts = database.connection.prepare(
    "SELECT COUNT(*) AS count FROM admin_accounts"
  ).get() as unknown as CountRow;
  checks.push(adminAccountsCheck(accounts.count));

  const model = database.connection.prepare(`
    SELECT model_name, last_test_status FROM agent_model_config WHERE id = 1
  `).get() as unknown as ModelConfigRow | undefined;
  checks.push(modelConfigCheck(model));

  const failedKnowledge = database.connection.prepare(`
    SELECT COUNT(*) AS count FROM agent_knowledge_items WHERE status = 'index_failed'
  `).get() as unknown as CountRow;
  checks.push(knowledgeIndexCheck(failedKnowledge.count));

  checks.push(ENVIRONMENT_DATA_CHECK);

  return {
    checks,
    healthy: checks.every((check) => check.status !== "failed")
  };
}

export function createAdminApplication(
  path: string,
  options: { mediaDirectory?: string; databaseUrl?: string | undefined } = {}
): KangminAdminApplication {
  // 与患者端一致的密钥策略（fail-closed）：KANGMIN_ENCRYPTION_KEYS → AES；
  // local/integration 或显式 KANGMIN_ALLOW_DEV_SESSION=1 → 明文开发降级；
  // 其余环境 → config_missing。API Key 与旧库回填依赖该端口。
  const encryption = resolveEncryption(process.env);
  const mediaDirectory = options.mediaDirectory ?? defaultMediaDirectory(path);

  const databaseUrl = resolveDatabaseUrl(options);
  if (databaseUrl !== undefined) {
    const database = new KangminPgDatabase(databaseUrl);
    return new KangminAdminApplication(
      new PgAdminSessionRepository(database),
      new PgAdminAccountRepository(database),
      new PgContentAdminRepository(database),
      new PgContentAuxRepository(database),
      new PgAgentAdminRepository(database, encryption),
      new BuiltinSyndromeRegistry(),
      new PgUserAdminRepository(database),
      mediaDirectory,
      new PgAuditRepository(database),
      () => {
        void database.close();
      },
      () => pgDoctorChecks(database, mediaDirectory)
    );
  }

  const database = new KangminDatabase(path, encryption);
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
