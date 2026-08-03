import { accessSync, constants } from "node:fs";
import { dirname, join } from "node:path";

import { KangminAdminApplication, type DoctorCheck, type DoctorReport } from "./admin-application.js";
import {
  resolveDatabaseUrl,
  resolveEncryption,
  type ReadinessProbe
} from "./composition-root.js";
import { KangminDatabase, appliedMigrationVersions } from "../infrastructure/database.js";
import { LocalFilesystemObjectStorage } from "../infrastructure/local-filesystem-object-storage.js";
import { S3ObjectStorage } from "../infrastructure/s3-object-storage.js";
import { DomainError } from "../kernel/errors.js";
import type {
  ObjectHead,
  ObjectStoragePort,
  ObjectUploadTicket
} from "../modules/system/object-storage-ports.js";
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

/**
 * 管理端生产存储 fail-closed（与患者端 assertProductionStorage 同策略）：
 * KANGMIN_APP_ENV=staging|production 时，缺 KANGMIN_DATABASE_URL、缺
 * KANGMIN_S3_BUCKET 或出现 KANGMIN_ALLOW_DEV_SESSION=1 一律
 * config_missing；local/integration 不校验（本地零影响）。
 */
export function assertProductionStorage(
  environment: NodeJS.ProcessEnv
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
}

/**
 * 对象存储 /ready 探针：S3 后端用 headObject 探测桶与凭证（对象无需
 * 存在，不抛即可用）；本地文件系统后端保持目录 R_OK/W_OK 检查
 * （生产由 assertProductionStorage 阻断，本地后端只服务 local/
 * integration）。固定文案，不泄露桶名/端点/绝对路径。
 */
function objectStorageReadinessProbe(
  storage: ObjectStoragePort,
  mediaDirectory: string
): ReadinessProbe {
  return {
    name: "object-storage",
    run: async () => {
      if (storage instanceof S3ObjectStorage) {
        try {
          await storage.headObject("__readiness_probe__");
          return { status: "ok", message: "对象存储可用" };
        } catch {
          return {
            status: "failed",
            message: "对象存储不可用（检查桶与凭证配置）"
          };
        }
      }
      try {
        accessSync(mediaDirectory, constants.R_OK | constants.W_OK);
        return { status: "ok", message: "素材目录可读写" };
      } catch {
        return {
          status: "failed",
          message: "素材目录不可读写（检查权限与磁盘空间）"
        };
      }
    }
  };
}

/**
 * 本地存储延迟创建：LocalFilesystemObjectStorage 构造即创建根目录，若
 * 组合根启动时就实例化，素材目录会被提前创建，doctor 的"目录缺失或不可
 * 读写即 failed"语义失效（既有 CLI 契约：未引导环境 doctor 不健康）。
 * 首次实际读写时才创建目录，保持既有 doctor 行为。
 */
class LazyLocalObjectStorage implements ObjectStoragePort {
  private inner: ObjectStoragePort | undefined;

  constructor(private readonly rootDirectory: string) {}

  private storage(): ObjectStoragePort {
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

  verifyObject(input: {
    key: string;
    sha256: string;
    sizeBytes: number;
  }): Promise<boolean> {
    return this.storage().verifyObject(input);
  }
}

/**
 * 对象存储选择：显式注入优先（测试/远程编排）；否则 KANGMIN_S3_BUCKET
 * 存在 → S3 兼容后端（缺访问凭证抛 config_missing）；否则本地文件系统
 * （mediaDirectory 照旧解析，语义与改造前一致）。
 */
function resolveObjectStorage(
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
      secretAccessKey
    });
  }
  return new LazyLocalObjectStorage(mediaDirectory);
}

/**
 * 素材存储探针（SQLite 与 PostgreSQL doctor 共用；固定文案，不输出绝对路径，
 * 不泄露桶名/端点等细节）。本地后端保持目录 R_OK/W_OK 检查；S3 后端用
 * headObject 探测——正常返回（含 null，对象无需存在）即证明桶与凭证可用。
 */
async function mediaStorageCheck(
  storage: ObjectStoragePort,
  mediaDirectory: string
): Promise<DoctorCheck> {
  if (storage instanceof S3ObjectStorage) {
    try {
      await storage.headObject("__doctor_probe__");
      return {
        name: "media-storage",
        status: "ok",
        message: "素材对象存储可用"
      };
    } catch {
      return {
        name: "media-storage",
        status: "failed",
        message: "素材对象存储不可用（检查桶与凭证配置）"
      };
    }
  }
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
  storage: ObjectStoragePort,
  mediaDirectory: string
): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [
    databaseMigrationsCheck(await appliedPgMigrationVersions(database)),
    await mediaStorageCheck(storage, mediaDirectory)
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
async function doctorChecks(
  database: KangminDatabase,
  storage: ObjectStoragePort,
  mediaDirectory: string
): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [
    databaseMigrationsCheck(appliedMigrationVersions(database)),
    await mediaStorageCheck(storage, mediaDirectory)
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

/** 管理端 /ready 探针集（数据库探针由患者端组合根提供，同一 PG）。 */
export interface AdminReadinessProbes {
  objectStorage: ReadinessProbe;
}

export interface AdminApplicationWithOps {
  application: KangminAdminApplication;
  readinessProbes: AdminReadinessProbes;
}

export function createAdminApplication(
  path: string,
  options: {
    mediaDirectory?: string;
    databaseUrl?: string | undefined;
    objectStorage?: ObjectStoragePort | undefined;
  } = {}
): KangminAdminApplication {
  return createAdminApplicationWithOps(path, options).application;
}

/**
 * 带运维语义的管理端装配：除应用实例外，同时返回对象存储就绪探针
 * （探针闭包复用同一存储实例，不另建客户端）。
 */
export function createAdminApplicationWithOps(
  path: string,
  options: {
    mediaDirectory?: string;
    databaseUrl?: string | undefined;
    objectStorage?: ObjectStoragePort | undefined;
  } = {}
): AdminApplicationWithOps {
  // 生产存储 fail-closed：staging/production 缺 PG / 缺对象存储桶 /
  // 出现开发会话开关一律 config_missing（local/integration 不校验）。
  assertProductionStorage(process.env);
  // 与患者端一致的密钥策略（fail-closed）：KANGMIN_ENCRYPTION_KEYS → AES；
  // local/integration 或显式 KANGMIN_ALLOW_DEV_SESSION=1 → 明文开发降级；
  // 其余环境 → config_missing。API Key 与旧库回填依赖该端口。
  const encryption = resolveEncryption(process.env);
  const mediaDirectory = options.mediaDirectory ?? defaultMediaDirectory(path);
  const objectStorage = resolveObjectStorage(options, mediaDirectory);
  const readinessProbes: AdminReadinessProbes = {
    objectStorage: objectStorageReadinessProbe(objectStorage, mediaDirectory)
  };

  const databaseUrl = resolveDatabaseUrl(options);
  if (databaseUrl !== undefined) {
    const database = new KangminPgDatabase(databaseUrl);
    return {
      application: new KangminAdminApplication(
        new PgAdminSessionRepository(database),
        new PgAdminAccountRepository(database),
        new PgContentAdminRepository(database),
        new PgContentAuxRepository(database),
        new PgAgentAdminRepository(database, encryption),
        new BuiltinSyndromeRegistry(),
        new PgUserAdminRepository(database),
        objectStorage,
        new PgAuditRepository(database),
        () => {
          void database.close();
        },
        () => pgDoctorChecks(database, objectStorage, mediaDirectory)
      ),
      readinessProbes
    };
  }

  const database = new KangminDatabase(path, encryption);
  const sessionRepository = new SqliteAdminSessionRepository(database);
  const accountRepository = new SqliteAdminAccountRepository(database);
  const contentRepository = new SqliteContentAdminRepository(database);
  const auxRepository = new SqliteContentAuxRepository(database);
  const agentRepository = new SqliteAgentAdminRepository(database, encryption);
  const userRepository = new SqliteUserAdminRepository(database);
  const auditRepository = new SqliteAuditRepository(database);
  return {
    application: new KangminAdminApplication(
      sessionRepository,
      accountRepository,
      contentRepository,
      auxRepository,
      agentRepository,
      new BuiltinSyndromeRegistry(),
      userRepository,
      objectStorage,
      auditRepository,
      () => {
        database.close();
      },
      () => doctorChecks(database, objectStorage, mediaDirectory)
    ),
    readinessProbes
  };
}
