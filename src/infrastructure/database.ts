import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";

import { DomainError } from "../kernel/errors.js";
import type { EncryptionPort } from "../kernel/encryption.js";
import { encryptStoredField } from "./encrypted-fields.js";

/**
 * 一个版本化迁移：version 单调递增，apply 在同一事务内执行。
 * 加密类迁移需要 encryption 端口对旧明文数据做加密回填；
 * 非加密迁移忽略该参数。
 */
interface Migration {
  version: string;
  apply: (
    connection: DatabaseSync,
    encryption: EncryptionPort | undefined
  ) => void;
}

/**
 * 把旧表的明文列加密回填到重建表的目标密文列。
 * 目标列与 encryption_key_version 由同一 UPDATE 写入；
 * 存在待回填明文但未提供加密端口时抛 config_missing，绝不静默丢失数据。
 */
function backfillEncryptedColumn(
  connection: DatabaseSync,
  sourceTable: string,
  sourceColumn: string,
  targetTable: string,
  targetColumn: string,
  idColumn: string,
  encryption: EncryptionPort | undefined
): void {
  const rows = connection
    .prepare(
      `SELECT ${idColumn} AS id, ${sourceColumn} AS value
       FROM ${sourceTable}
       WHERE ${sourceColumn} IS NOT NULL`
    )
    .all() as unknown as Array<{ id: string; value: string }>;
  if (rows.length === 0) {
    return;
  }
  if (encryption === undefined) {
    throw new DomainError(
      "config_missing",
      `检测到未加密的旧数据（${sourceTable}.${sourceColumn}），但未提供加密端口，无法安全迁移`
    );
  }
  const update = connection.prepare(
    `UPDATE ${targetTable}
     SET ${targetColumn} = ?, encryption_key_version = ?
     WHERE ${idColumn} = ?`
  );
  for (const row of rows) {
    const { stored, keyVersion } = encryptStoredField(encryption, row.value);
    update.run(stored, keyVersion, row.id);
  }
}

const MIGRATIONS: Migration[] = [
  {
    version: "0001_patient_record_baseline",
    apply: (connection) => {
      connection.exec(`
        CREATE TABLE IF NOT EXISTS patients (
          id TEXT PRIMARY KEY,
          development_subject TEXT UNIQUE,
          created_at TEXT NOT NULL
        ) STRICT;

        CREATE TABLE IF NOT EXISTS patient_sessions (
          token_hash TEXT PRIMARY KEY,
          patient_id TEXT NOT NULL REFERENCES patients(id),
          expires_at TEXT NOT NULL,
          created_at TEXT NOT NULL
        ) STRICT;

        CREATE TABLE IF NOT EXISTS symptom_records (
          id TEXT PRIMARY KEY,
          patient_id TEXT NOT NULL REFERENCES patients(id),
          local_date TEXT NOT NULL,
          nasal_congestion INTEGER NOT NULL CHECK(nasal_congestion BETWEEN 0 AND 3),
          nasal_itching INTEGER NOT NULL CHECK(nasal_itching BETWEEN 0 AND 3),
          sneezing INTEGER NOT NULL CHECK(sneezing BETWEEN 0 AND 3),
          runny_nose INTEGER NOT NULL CHECK(runny_nose BETWEEN 0 AND 3),
          tnss_total INTEGER NOT NULL CHECK(tnss_total BETWEEN 0 AND 12),
          notes TEXT,
          revision INTEGER NOT NULL CHECK(revision >= 1),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE(patient_id, local_date)
        ) STRICT;

        CREATE INDEX IF NOT EXISTS symptom_records_patient_date
        ON symptom_records(patient_id, local_date DESC);

        CREATE TABLE IF NOT EXISTS idempotency_records (
          patient_id TEXT NOT NULL REFERENCES patients(id),
          command_scope TEXT NOT NULL,
          idempotency_key TEXT NOT NULL,
          request_hash TEXT NOT NULL,
          result_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY(patient_id, command_scope, idempotency_key)
        ) STRICT;

        CREATE TABLE IF NOT EXISTS profiles (
          patient_id TEXT PRIMARY KEY REFERENCES patients(id),
          display_name TEXT,
          birth_date TEXT,
          sex TEXT NOT NULL DEFAULT 'unspecified'
            CHECK(sex IN ('female', 'male', 'other', 'unspecified')),
          allergy_history TEXT,
          known_allergies TEXT,
          common_triggers TEXT,
          notes TEXT,
          revision INTEGER NOT NULL CHECK(revision >= 1),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT;

        CREATE TABLE IF NOT EXISTS exposure_records (
          id TEXT PRIMARY KEY,
          patient_id TEXT NOT NULL REFERENCES patients(id),
          local_date TEXT NOT NULL,
          factors_json TEXT NOT NULL,
          other_description TEXT,
          notes TEXT,
          revision INTEGER NOT NULL CHECK(revision >= 1),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE(patient_id, local_date)
        ) STRICT;

        CREATE INDEX IF NOT EXISTS exposure_records_patient_date
        ON exposure_records(patient_id, local_date DESC);

        CREATE TABLE IF NOT EXISTS medication_records (
          id TEXT PRIMARY KEY,
          patient_id TEXT NOT NULL REFERENCES patients(id),
          local_date TEXT NOT NULL,
          medication_name TEXT NOT NULL,
          dosage TEXT,
          actual_use TEXT,
          notes TEXT,
          revision INTEGER NOT NULL CHECK(revision >= 1),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT;

        CREATE INDEX IF NOT EXISTS medication_records_patient_date
        ON medication_records(patient_id, local_date DESC);
      `);
    }
  },
  {
    version: "0002_system_ledger",
    apply: (connection) => {
      connection.exec(`
        -- 患者记录每次更新/删除追加的最小历史凭证（数据库设计 §4.2）。
        -- 载荷为认证加密快照，正文不进普通日志；创建时 record_type 由代码固定枚举。
        CREATE TABLE IF NOT EXISTS patient_record_versions (
          record_type TEXT NOT NULL
            CHECK(record_type IN ('symptom', 'profile', 'exposure', 'medication')),
          record_id TEXT NOT NULL,
          revision INTEGER NOT NULL CHECK(revision >= 1),
          operation TEXT NOT NULL CHECK(operation IN ('create', 'update', 'delete')),
          encrypted_snapshot TEXT NOT NULL,
          encryption_key_version TEXT NOT NULL,
          actor_kind TEXT NOT NULL CHECK(actor_kind IN ('patient', 'system')),
          actor_id TEXT,
          request_id TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY(record_type, record_id, revision)
        ) STRICT;

        -- 只追加审计（数据库设计 §4.6）：发布、启停、管理员变更、
        -- 敏感详情读取和数据请求状态变化必须记录结构固定、脱敏的前后值。
        CREATE TABLE IF NOT EXISTS audit_events (
          id TEXT PRIMARY KEY,
          actor_kind TEXT NOT NULL CHECK(actor_kind IN ('patient', 'admin', 'system')),
          actor_id TEXT NOT NULL,
          action TEXT NOT NULL,
          entity_type TEXT NOT NULL,
          entity_id TEXT NOT NULL,
          entity_revision INTEGER,
          request_id TEXT,
          details_json TEXT NOT NULL,
          created_at TEXT NOT NULL
        ) STRICT;

        CREATE INDEX IF NOT EXISTS audit_events_entity
        ON audit_events(entity_type, entity_id, created_at DESC);

        CREATE INDEX IF NOT EXISTS audit_events_actor
        ON audit_events(actor_kind, actor_id, created_at DESC);
      `);
    }
  },
  {
    version: "0003_identity",
    apply: (connection) => {
      connection.exec(`
        -- 本地患者账号最小集：username_hash 是登录标识哈希（未来可替换为
        -- 手机号 HMAC），密码仅存 scrypt 哈希。生产身份（微信等）通过
        -- 外部身份端口接入，本表是本地交付形态的自包含凭据来源。
        CREATE TABLE IF NOT EXISTS patient_accounts (
          patient_id TEXT PRIMARY KEY REFERENCES patients(id),
          username_hash TEXT NOT NULL UNIQUE,
          password_hash TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'active'
            CHECK(status IN ('active', 'deactivated', 'deletion_pending')),
          nickname TEXT,
          revision INTEGER NOT NULL CHECK(revision >= 1),
          last_active_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT;

        -- 管理员独立身份空间（数据库设计 §4.1）：与患者会话不共用身份。
        -- 默认只有 owner 可读取 users 敏感详情；停用管理员与撤销会话同事务。
        CREATE TABLE IF NOT EXISTS admin_accounts (
          id TEXT PRIMARY KEY,
          username TEXT NOT NULL UNIQUE,
          password_hash TEXT NOT NULL,
          role TEXT NOT NULL CHECK(role IN ('owner', 'admin')),
          status TEXT NOT NULL DEFAULT 'active'
            CHECK(status IN ('active', 'disabled')),
          revision INTEGER NOT NULL CHECK(revision >= 1),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT;

        CREATE TABLE IF NOT EXISTS admin_sessions (
          token_hash TEXT PRIMARY KEY,
          admin_id TEXT NOT NULL REFERENCES admin_accounts(id),
          expires_at TEXT NOT NULL,
          created_at TEXT NOT NULL,
          revoked_at TEXT,
          revoked_reason TEXT
        ) STRICT;

        CREATE INDEX IF NOT EXISTS admin_sessions_admin
        ON admin_sessions(admin_id);
      `);
    }
  },
  {
    version: "0004_origin_main_tables",
    apply: (connection) => {
      connection.exec(`
        -- 并行交付流（#131/#133/#135）加入的表，纳入统一迁移账本。
        -- 注意：admin_sessions 已由 0003_identity 以 admin_accounts 为准创建；
        -- origin/main 的 dev-admin 代码仍按旧结构写入，FK 集成缺口由 w5 修复。
        CREATE TABLE IF NOT EXISTS content_items (
          id TEXT PRIMARY KEY,
          kind TEXT NOT NULL CHECK(kind IN ('article', 'video')),
          title TEXT NOT NULL,
          category TEXT NOT NULL,
          summary TEXT NOT NULL,
          body TEXT,
          source TEXT NOT NULL,
          cover_url TEXT,
          media_url TEXT,
          status TEXT NOT NULL
            CHECK(status IN ('draft', 'review', 'published', 'unpublished', 'failed')),
          patient_visible INTEGER NOT NULL CHECK(patient_visible IN (0, 1)),
          version_valid INTEGER NOT NULL CHECK(version_valid IN (0, 1)),
          media_available INTEGER NOT NULL CHECK(media_available IN (0, 1)),
          published_at TEXT,
          updated_at TEXT NOT NULL
        ) STRICT;

        CREATE INDEX IF NOT EXISTS content_items_public_kind_updated
        ON content_items(kind, status, patient_visible, updated_at DESC);

        CREATE TABLE IF NOT EXISTS admins (
          id TEXT PRIMARY KEY, development_subject TEXT UNIQUE,
          role TEXT NOT NULL CHECK(role IN ('owner', 'admin')),
          enabled INTEGER NOT NULL CHECK(enabled IN (0, 1)), created_at TEXT NOT NULL
        ) STRICT;

        CREATE TABLE IF NOT EXISTS admin_idempotency (
          admin_id TEXT NOT NULL REFERENCES admins(id), scope TEXT NOT NULL,
          idempotency_key TEXT NOT NULL, request_hash TEXT NOT NULL,
          result_json TEXT NOT NULL, created_at TEXT NOT NULL,
          PRIMARY KEY(admin_id, scope, idempotency_key)
        ) STRICT;

        CREATE TABLE IF NOT EXISTS agent_sessions (
          id TEXT PRIMARY KEY,
          patient_id TEXT NOT NULL REFERENCES patients(id),
          status TEXT NOT NULL
            CHECK(status IN ('awaiting_answer', 'safety_blocked', 'completed')),
          revision INTEGER NOT NULL CHECK(revision >= 1),
          session_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT;

        CREATE INDEX IF NOT EXISTS agent_sessions_patient_updated
        ON agent_sessions(patient_id, updated_at DESC);
      `);
      // origin/main 的兼容逻辑：旧库 content_items 缺列时补齐。
      const columns = connection.prepare("PRAGMA table_info(content_items)").all() as unknown as Array<{ name: string }>;
      if (!columns.some((column) => column.name === "revision")) {
        connection.exec("ALTER TABLE content_items ADD COLUMN revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1)");
      }
      if (!columns.some((column) => column.name === "created_by")) {
        connection.exec("ALTER TABLE content_items ADD COLUMN created_by TEXT");
      }
    }
  },
  {
    version: "0005_record_encryption_soft_delete",
    apply: (connection, encryption) => {
      // 健康正文字段落地认证加密（数据库设计 §4.2）：原明文列替换为
      // *_encrypted 自包含密文 JSON + 表级 encryption_key_version；
      // birth_date/sex/factors_json 保持明文。
      // 删除语义改为软删除（deleted_at），同日唯一约束改为
      // 部分唯一索引（WHERE deleted_at IS NULL），删除后同日可重建。
      // 旧明文数据在重建期间用当前密钥加密回填。
      connection.exec(`
        CREATE TABLE symptom_records_new (
          id TEXT PRIMARY KEY,
          patient_id TEXT NOT NULL REFERENCES patients(id),
          local_date TEXT NOT NULL,
          nasal_congestion INTEGER NOT NULL CHECK(nasal_congestion BETWEEN 0 AND 3),
          nasal_itching INTEGER NOT NULL CHECK(nasal_itching BETWEEN 0 AND 3),
          sneezing INTEGER NOT NULL CHECK(sneezing BETWEEN 0 AND 3),
          runny_nose INTEGER NOT NULL CHECK(runny_nose BETWEEN 0 AND 3),
          tnss_total INTEGER NOT NULL CHECK(tnss_total BETWEEN 0 AND 12),
          notes_encrypted TEXT,
          encryption_key_version TEXT,
          deleted_at TEXT,
          revision INTEGER NOT NULL CHECK(revision >= 1),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT;

        INSERT INTO symptom_records_new(
          id, patient_id, local_date,
          nasal_congestion, nasal_itching, sneezing, runny_nose,
          tnss_total, revision, created_at, updated_at
        )
        SELECT id, patient_id, local_date,
          nasal_congestion, nasal_itching, sneezing, runny_nose,
          tnss_total, revision, created_at, updated_at
        FROM symptom_records;
      `);
      backfillEncryptedColumn(
        connection,
        "symptom_records", "notes",
        "symptom_records_new", "notes_encrypted", "id",
        encryption
      );
      connection.exec(`
        DROP TABLE symptom_records;
        ALTER TABLE symptom_records_new RENAME TO symptom_records;

        CREATE INDEX symptom_records_patient_date
        ON symptom_records(patient_id, local_date DESC);
        CREATE UNIQUE INDEX symptom_records_patient_date_active
        ON symptom_records(patient_id, local_date) WHERE deleted_at IS NULL;

        CREATE TABLE exposure_records_new (
          id TEXT PRIMARY KEY,
          patient_id TEXT NOT NULL REFERENCES patients(id),
          local_date TEXT NOT NULL,
          factors_json TEXT NOT NULL,
          other_description_encrypted TEXT,
          notes_encrypted TEXT,
          encryption_key_version TEXT,
          deleted_at TEXT,
          revision INTEGER NOT NULL CHECK(revision >= 1),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT;

        INSERT INTO exposure_records_new(
          id, patient_id, local_date, factors_json,
          revision, created_at, updated_at
        )
        SELECT id, patient_id, local_date, factors_json,
          revision, created_at, updated_at
        FROM exposure_records;
      `);
      backfillEncryptedColumn(
        connection,
        "exposure_records", "other_description",
        "exposure_records_new", "other_description_encrypted", "id",
        encryption
      );
      backfillEncryptedColumn(
        connection,
        "exposure_records", "notes",
        "exposure_records_new", "notes_encrypted", "id",
        encryption
      );
      connection.exec(`
        DROP TABLE exposure_records;
        ALTER TABLE exposure_records_new RENAME TO exposure_records;

        CREATE INDEX exposure_records_patient_date
        ON exposure_records(patient_id, local_date DESC);
        CREATE UNIQUE INDEX exposure_records_patient_date_active
        ON exposure_records(patient_id, local_date) WHERE deleted_at IS NULL;

        CREATE TABLE medication_records_new (
          id TEXT PRIMARY KEY,
          patient_id TEXT NOT NULL REFERENCES patients(id),
          local_date TEXT NOT NULL,
          medication_name_encrypted TEXT NOT NULL,
          dosage_encrypted TEXT,
          actual_use_encrypted TEXT,
          notes_encrypted TEXT,
          encryption_key_version TEXT,
          deleted_at TEXT,
          revision INTEGER NOT NULL CHECK(revision >= 1),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT;

        INSERT INTO medication_records_new(
          id, patient_id, local_date,
          revision, created_at, updated_at
        )
        SELECT id, patient_id, local_date,
          revision, created_at, updated_at
        FROM medication_records;
      `);
      backfillEncryptedColumn(
        connection,
        "medication_records", "medication_name",
        "medication_records_new", "medication_name_encrypted", "id",
        encryption
      );
      backfillEncryptedColumn(
        connection,
        "medication_records", "dosage",
        "medication_records_new", "dosage_encrypted", "id",
        encryption
      );
      backfillEncryptedColumn(
        connection,
        "medication_records", "actual_use",
        "medication_records_new", "actual_use_encrypted", "id",
        encryption
      );
      backfillEncryptedColumn(
        connection,
        "medication_records", "notes",
        "medication_records_new", "notes_encrypted", "id",
        encryption
      );
      connection.exec(`
        DROP TABLE medication_records;
        ALTER TABLE medication_records_new RENAME TO medication_records;

        CREATE INDEX medication_records_patient_date
        ON medication_records(patient_id, local_date DESC);

        CREATE TABLE profiles_new (
          patient_id TEXT PRIMARY KEY REFERENCES patients(id),
          display_name_encrypted TEXT,
          birth_date TEXT,
          sex TEXT NOT NULL DEFAULT 'unspecified'
            CHECK(sex IN ('female', 'male', 'other', 'unspecified')),
          allergy_history_encrypted TEXT,
          known_allergies_encrypted TEXT,
          common_triggers_encrypted TEXT,
          notes_encrypted TEXT,
          encryption_key_version TEXT,
          revision INTEGER NOT NULL CHECK(revision >= 1),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT;

        INSERT INTO profiles_new(
          patient_id, birth_date, sex,
          revision, created_at, updated_at
        )
        SELECT patient_id, birth_date, sex,
          revision, created_at, updated_at
        FROM profiles;
      `);
      backfillEncryptedColumn(
        connection,
        "profiles", "display_name",
        "profiles_new", "display_name_encrypted", "patient_id",
        encryption
      );
      backfillEncryptedColumn(
        connection,
        "profiles", "allergy_history",
        "profiles_new", "allergy_history_encrypted", "patient_id",
        encryption
      );
      backfillEncryptedColumn(
        connection,
        "profiles", "known_allergies",
        "profiles_new", "known_allergies_encrypted", "patient_id",
        encryption
      );
      backfillEncryptedColumn(
        connection,
        "profiles", "common_triggers",
        "profiles_new", "common_triggers_encrypted", "patient_id",
        encryption
      );
      backfillEncryptedColumn(
        connection,
        "profiles", "notes",
        "profiles_new", "notes_encrypted", "patient_id",
        encryption
      );
      connection.exec(`
        DROP TABLE profiles;
        ALTER TABLE profiles_new RENAME TO profiles;
      `);
    }
  },
  {
    version: "0006_account_sessions_and_consents",
    apply: (connection) => {
      connection.exec(`
        -- 会话来源区分（患者 CLI 设计 §9.3）：development=开发会话、
        -- mini_program=小程序本地账号会话、cli=CLI 本地账号会话。
        -- 默认 development 兼容既有开发会话插入代码与存量行；
        -- revoked_at 用于 logout 撤销（标记而非删除，保留审计线索）。
        ALTER TABLE patient_sessions
          ADD COLUMN client_kind TEXT NOT NULL DEFAULT 'development'
            CHECK(client_kind IN ('development', 'mini_program', 'cli'));
        ALTER TABLE patient_sessions ADD COLUMN revoked_at TEXT;

        -- 账号资料展示需要脱敏用户名：用户名本身只存 SHA-256 哈希
        -- （防明文索引），脱敏形态在注册时一次性派生、只作展示用。
        ALTER TABLE patient_accounts
          ADD COLUMN username_masked TEXT NOT NULL DEFAULT '';

        -- 同意最小集（患者 CLI 设计 §9.5）：只追加，按患者+类型序号
        -- 递增；撤回通过追加 withdrawn 决策实现，绝不静默删除旧决策。
        CREATE TABLE IF NOT EXISTS patient_consents (
          patient_id TEXT NOT NULL REFERENCES patients(id),
          consent_type TEXT NOT NULL
            CHECK(consent_type IN ('privacy', 'medical_boundary')),
          sequence INTEGER NOT NULL CHECK(sequence >= 1),
          decision TEXT NOT NULL
            CHECK(decision IN ('granted', 'withdrawn')),
          policy_version TEXT NOT NULL,
          request_id TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY(patient_id, consent_type, sequence)
        ) STRICT;

        CREATE INDEX IF NOT EXISTS patient_consents_latest
        ON patient_consents(patient_id, consent_type, sequence DESC);
      `);
    }
  },
  {
    version: "0007_browse_environment_plans",
    apply: (connection) => {
      connection.exec(`
        -- 患者端 browse 增量（issue-136 w3-browse）：
        -- 通用护理方案只读（published_revision 非空才可见）与
        -- 环境快照缓存（架构 §19 EnvironmentProviderPort）。
        -- 内容资源由 0004 的 content_items 承载，本迁移不重复建表。

        CREATE TABLE IF NOT EXISTS agent_care_plans (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          current_revision INTEGER NOT NULL CHECK(current_revision >= 1),
          enabled_revision INTEGER,
          published_revision INTEGER,
          revision INTEGER NOT NULL CHECK(revision >= 1)
        ) STRICT;

        -- 方案修订内容承载：plan show/search 的只读正文来源。
        CREATE TABLE IF NOT EXISTS agent_care_plan_revisions (
          plan_id TEXT NOT NULL REFERENCES agent_care_plans(id),
          revision INTEGER NOT NULL CHECK(revision >= 1),
          name TEXT NOT NULL,
          summary TEXT,
          steps_json TEXT,
          disclaimer TEXT,
          created_by_admin_id TEXT,
          PRIMARY KEY(plan_id, revision)
        ) STRICT;

        -- 环境快照缓存：过期快照返回 stale 标记而不是“刚刚更新”。
        CREATE TABLE IF NOT EXISTS environment_snapshots (
          id TEXT PRIMARY KEY,
          provider TEXT NOT NULL,
          cache_key TEXT NOT NULL,
          city TEXT NOT NULL,
          weather_json TEXT NOT NULL,
          air_quality_json TEXT NOT NULL,
          pollen_risk_json TEXT NOT NULL,
          observed_at TEXT NOT NULL,
          fetched_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          source_label TEXT NOT NULL,
          UNIQUE(provider, cache_key)
        ) STRICT;
      `);
    }
  }
];

export class KangminDatabase {
  readonly connection: DatabaseSync;

  constructor(path: string, private readonly encryption?: EncryptionPort) {
    try {
      if (path !== ":memory:") {
        mkdirSync(dirname(path), { recursive: true });
      }
      this.connection = new DatabaseSync(path);
      this.connection.exec("PRAGMA foreign_keys = ON");
      this.connection.exec("PRAGMA journal_mode = WAL");
      // 跨进程并发写时等待锁而非立即失败；见 transaction() 的 BUSY 映射。
      this.connection.exec("PRAGMA busy_timeout = 3000");
      this.migrate();
    } catch (error) {
      throw new DomainError(
        "storage_unavailable",
        "健康记录存储不可用",
        { retryable: true, cause: error }
      );
    }
  }

  close(): void {
    this.connection.close();
  }

  transaction<T>(operation: () => T): T {
    this.beginImmediate();
    try {
      const result = operation();
      this.connection.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.connection.exec("ROLLBACK");
      } catch {
        // Preserve the original domain/storage failure.
      }
      if (String(error).includes("database is locked")) {
        // 跨进程瞬时锁争用：可重试，不应归一化为内部错误。
        throw new DomainError(
          "storage_unavailable",
          "健康记录存储正被其他进程占用，请稍后重试",
          { retryable: true, cause: error }
        );
      }
      throw error;
    }
  }

  /**
   * 只读事务使用 BEGIN DEFERRED：WAL 模式下不获取任何锁，
   * 多个并发读取互不阻塞，也不会被写事务持锁拖死。
   */
  readOnly<T>(operation: () => T): T {
    this.connection.exec("BEGIN");
    try {
      const result = operation();
      this.connection.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.connection.exec("ROLLBACK");
      } catch {
        // Preserve the original domain/storage failure.
      }
      throw error;
    }
  }

  /**
   * SQLite 文档规定：BEGIN IMMEDIATE 在数据库被占用时立即返回 SQLITE_BUSY，
   * 不经过 busy handler，因此 PRAGMA busy_timeout 对 BEGIN 本身无效。
   * 这里做有限重试（约 3 秒）以容忍跨进程瞬时写锁；
   * 超时直接抛出可重试的 storage_unavailable，避免在 transaction() 的 try 块之外漏出裸 SQLITE_BUSY。
   */
  private beginImmediate(): void {
    const deadline = Date.now() + 3000;
    for (;;) {
      try {
        this.connection.exec("BEGIN IMMEDIATE");
        return;
      } catch (error) {
        if (!String(error).includes("database is locked")) {
          throw error;
        }
        if (Date.now() >= deadline) {
          throw new DomainError(
            "storage_unavailable",
            "健康记录存储正被其他进程占用，请稍后重试",
            { retryable: true, cause: error }
          );
        }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
      }
    }
  }

  /**
   * 版本化迁移：schema_migrations 账本记录已应用版本，未应用的按序
   * 在同一事务内执行。现有开发数据库通过 IF NOT EXISTS 无损升级。
   */
  private migrate(): void {
    this.connection.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL
      ) STRICT;
    `);

    const applied = new Set(
      (
        this.connection
          .prepare("SELECT version FROM schema_migrations")
          .all() as unknown as Array<{ version: string }>
      ).map((row) => row.version)
    );

    for (const migration of MIGRATIONS) {
      if (applied.has(migration.version)) {
        continue;
      }
      this.transaction(() => {
        migration.apply(this.connection, this.encryption);
        this.connection
          .prepare(
            "INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)"
          )
          .run(migration.version, new Date().toISOString());
      });
    }
  }
}

/** 供诊断命令（doctor）查询已应用的迁移版本。 */
export function appliedMigrationVersions(database: KangminDatabase): string[] {
  const statement: StatementSync = database.connection.prepare(
    "SELECT version FROM schema_migrations ORDER BY version ASC"
  );
  return (
    statement.all() as unknown as Array<{ version: string }>
  ).map((row) => row.version);
}
