import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";

import { DomainError } from "../kernel/errors.js";

/** 一个版本化迁移：version 单调递增，apply 在同一事务内执行。 */
interface Migration {
  version: string;
  apply: (connection: DatabaseSync) => void;
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
    version: "0005_admin_console",
    apply: (connection) => {
      connection.exec(`
        -- 管理端（w5）新增：内容分类、素材库、站内公告、知识库、调理方案、
        -- 模型设置与模拟测试用例。content_items（文章/视频）继续作为
        -- 患者 browse 的读取来源，这里只补充管理端写入所需的结构。
        CREATE TABLE IF NOT EXISTS content_categories (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL UNIQUE,
          kind TEXT NOT NULL CHECK(kind IN ('article', 'video', 'message', 'general')),
          description TEXT,
          display_order INTEGER NOT NULL DEFAULT 0 CHECK(display_order >= 0),
          status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'disabled')),
          revision INTEGER NOT NULL CHECK(revision >= 1),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT;

        CREATE INDEX IF NOT EXISTS content_categories_kind_order
        ON content_categories(kind, display_order, name);

        CREATE TABLE IF NOT EXISTS content_resource_media (
          id TEXT PRIMARY KEY,
          kind TEXT NOT NULL CHECK(kind IN ('image', 'video', 'word', 'pdf', 'markdown')),
          filename TEXT NOT NULL,
          stored_path TEXT NOT NULL,
          size_bytes INTEGER NOT NULL CHECK(size_bytes >= 0),
          mime_type TEXT,
          sha256 TEXT,
          status TEXT NOT NULL DEFAULT 'processing'
            CHECK(status IN ('processing', 'ready', 'failed', 'disabled')),
          failure_reason TEXT,
          created_by TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT;

        CREATE INDEX IF NOT EXISTS content_resource_media_created
        ON content_resource_media(created_at DESC);

        CREATE TABLE IF NOT EXISTS content_messages (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          body TEXT NOT NULL,
          summary TEXT,
          category_id TEXT REFERENCES content_categories(id),
          status TEXT NOT NULL CHECK(status IN ('draft', 'published', 'unpublished')),
          revision INTEGER NOT NULL CHECK(revision >= 1),
          published_at TEXT,
          created_by TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT;

        CREATE INDEX IF NOT EXISTS content_messages_status_created
        ON content_messages(status, created_at DESC);

        CREATE TABLE IF NOT EXISTS agent_knowledge_items (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          source TEXT,
          description TEXT,
          source_media_id TEXT REFERENCES content_resource_media(id),
          size_bytes INTEGER NOT NULL CHECK(size_bytes >= 0),
          mime_type TEXT,
          sha256 TEXT,
          status TEXT NOT NULL CHECK(status IN ('draft', 'processing', 'indexed', 'enabled', 'disabled', 'index_failed')),
          parse_error TEXT,
          chunk_count INTEGER NOT NULL DEFAULT 0 CHECK(chunk_count >= 0),
          created_by TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT;

        CREATE INDEX IF NOT EXISTS agent_knowledge_items_status
        ON agent_knowledge_items(status);

        CREATE TABLE IF NOT EXISTS agent_knowledge_chunks (
          knowledge_id TEXT NOT NULL REFERENCES agent_knowledge_items(id) ON DELETE CASCADE,
          chunk_index INTEGER NOT NULL CHECK(chunk_index >= 0),
          chunk_text TEXT NOT NULL,
          PRIMARY KEY(knowledge_id, chunk_index)
        ) STRICT;

        CREATE TABLE IF NOT EXISTS agent_plans (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          syndrome TEXT NOT NULL,
          method TEXT NOT NULL,
          steps_json TEXT NOT NULL,
          precautions TEXT NOT NULL,
          risks TEXT NOT NULL,
          contraindications TEXT NOT NULL,
          applicable_age TEXT,
          video_resource_id TEXT REFERENCES content_items(id),
          display_order INTEGER NOT NULL DEFAULT 0 CHECK(display_order >= 0),
          status TEXT NOT NULL CHECK(status IN ('draft', 'enabled', 'disabled')),
          revision INTEGER NOT NULL CHECK(revision >= 1),
          created_by TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT;

        CREATE INDEX IF NOT EXISTS agent_plans_syndrome_status
        ON agent_plans(syndrome, status);

        CREATE TABLE IF NOT EXISTS agent_model_config (
          id INTEGER PRIMARY KEY CHECK(id = 1),
          provider TEXT NOT NULL DEFAULT 'openai-compatible',
          model_name TEXT NOT NULL DEFAULT '',
          timeout_seconds INTEGER NOT NULL DEFAULT 30 CHECK(timeout_seconds BETWEEN 1 AND 300),
          max_output_tokens INTEGER NOT NULL DEFAULT 1024 CHECK(max_output_tokens BETWEEN 128 AND 32768),
          knowledge_retrieval_enabled INTEGER NOT NULL DEFAULT 0 CHECK(knowledge_retrieval_enabled IN (0, 1)),
          retrieval_count INTEGER NOT NULL DEFAULT 3 CHECK(retrieval_count BETWEEN 1 AND 20),
          explanation_enabled INTEGER NOT NULL DEFAULT 1 CHECK(explanation_enabled IN (0, 1)),
          api_key TEXT,
          updated_by TEXT,
          updated_at TEXT,
          last_test_status TEXT,
          last_test_at TEXT
        ) STRICT;

        CREATE TABLE IF NOT EXISTS agent_test_cases (
          id TEXT PRIMARY KEY,
          input_text TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('completed', 'failed')),
          result_json TEXT NOT NULL,
          created_by TEXT,
          created_at TEXT NOT NULL
        ) STRICT;

        CREATE INDEX IF NOT EXISTS agent_test_cases_created
        ON agent_test_cases(created_at DESC);
      `);
      // content_items 的视频/媒体字段：媒体引用列带 FK，旧库缺列时无损补齐。
      const contentColumns = connection.prepare("PRAGMA table_info(content_items)").all() as unknown as Array<{ name: string }>;
      const addColumn = (name: string, definition: string): void => {
        if (!contentColumns.some((column) => column.name === name)) {
          connection.exec(`ALTER TABLE content_items ADD COLUMN ${definition}`);
        }
      };
      addColumn("media_id", "media_id TEXT REFERENCES content_resource_media(id)");
      addColumn("cover_media_id", "cover_media_id TEXT REFERENCES content_resource_media(id)");
      addColumn("instructions", "instructions TEXT");
      addColumn("precautions", "precautions TEXT");
      addColumn("disclaimer", "disclaimer TEXT");
      addColumn("method_tags", "method_tags TEXT");
      addColumn("display_order", "display_order INTEGER NOT NULL DEFAULT 0 CHECK(display_order >= 0)");
    }
  }
];

export class KangminDatabase {
  readonly connection: DatabaseSync;

  constructor(path: string) {
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
        migration.apply(this.connection);
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
