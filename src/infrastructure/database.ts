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

        -- medication_name_encrypted 为 NOT NULL：旧库含用药记录时
        -- 缺列 INSERT 直接违约（升级路径 P0）。先写占位空串，随后的
        -- backfillEncryptedColumn 在同一事务内用真实密文覆盖
        -- （旧表 medication_name NOT NULL，全部行都会回填，占位不残留）。
        INSERT INTO medication_records_new(
          id, patient_id, local_date, medication_name_encrypted,
          revision, created_at, updated_at
        )
        SELECT id, patient_id, local_date, '',
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
  },
  {
    // 消息驱动 Agent 完整对话（w4 issue-136）：数据库设计 §4.5 简化。
    // agent_sessions 表已被 #131 确定性安全循环占用，本迁移使用
    // agent_conversations 作为对话会话表，子表沿用 §4.5 命名与约束。
    version: "0008_agent_conversations",
    apply: (connection) => {
      connection.exec(`
        CREATE TABLE IF NOT EXISTS agent_conversations (
          id TEXT PRIMARY KEY,
          patient_id TEXT REFERENCES patients(id),
          state TEXT NOT NULL
            CHECK(state IN ('active', 'completed', 'abandoned')),
          save_consent_id TEXT,
          rule_package_version TEXT NOT NULL,
          rule_package_hash TEXT NOT NULL,
          revision INTEGER NOT NULL CHECK(revision >= 1),
          last_sequence INTEGER NOT NULL CHECK(last_sequence >= 0),
          closed_at TEXT,
          retention_until TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT;

        CREATE INDEX IF NOT EXISTS agent_conversations_patient_updated
        ON agent_conversations(patient_id, updated_at DESC);

        -- 聊天正文只存密文 + 校验哈希；assistant 消息必须绑定已完成 decision。
        CREATE TABLE IF NOT EXISTS agent_messages (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL REFERENCES agent_conversations(id),
          sequence INTEGER NOT NULL CHECK(sequence >= 1),
          role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system_notice')),
          decision_id TEXT,
          content_encrypted TEXT NOT NULL,
          content_hash TEXT NOT NULL,
          encryption_key_version TEXT NOT NULL,
          created_at TEXT NOT NULL,
          UNIQUE(session_id, sequence)
        ) STRICT;

        -- 患者确认事实（三态 yes/no/unknown + value），unknown 是正式状态。
        CREATE TABLE IF NOT EXISTS agent_confirmed_answers (
          session_id TEXT NOT NULL REFERENCES agent_conversations(id),
          field_code TEXT NOT NULL,
          value TEXT NOT NULL
            CHECK(value IN ('missing', 'unknown', 'yes', 'no', 'value')),
          fact_value TEXT,
          source TEXT NOT NULL,
          rule_package_version TEXT NOT NULL,
          rule_package_hash TEXT NOT NULL,
          revision INTEGER NOT NULL CHECK(revision >= 1),
          confirmed_at TEXT NOT NULL,
          PRIMARY KEY(session_id, field_code)
        ) STRICT;

        -- 模型候选：proposed 阶段绝不进入规则输入；确认后由患者事实取代。
        CREATE TABLE IF NOT EXISTS agent_candidates (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL REFERENCES agent_conversations(id),
          field_code TEXT NOT NULL,
          proposed_value_encrypted TEXT,
          encryption_key_version TEXT NOT NULL,
          source_message_id TEXT,
          state TEXT NOT NULL
            CHECK(state IN ('proposed', 'adopted', 'ignored', 'expired')),
          created_at TEXT NOT NULL,
          decided_at TEXT
        ) STRICT;

        -- 决策凭证：输入快照加密 + 哈希；outcome/stage 与 §4.5 组合约束对齐。
        CREATE TABLE IF NOT EXISTS agent_decisions (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL REFERENCES agent_conversations(id),
          decision_sequence INTEGER NOT NULL CHECK(decision_sequence >= 1),
          session_revision INTEGER NOT NULL CHECK(session_revision >= 1),
          input_snapshot_encrypted TEXT NOT NULL,
          input_snapshot_hash TEXT NOT NULL,
          outcome TEXT NOT NULL
            CHECK(outcome IN ('blocked', 'need_more_information', 'non_applicable',
                              'conflict', 'no_match', 'classified')),
          stage TEXT NOT NULL
            CHECK(stage IN ('safety', 'applicability', 'severity',
                            'syndrome', 'plan_safety', 'completed')),
          severity_code TEXT,
          syndrome_code TEXT,
          next_questions_json TEXT NOT NULL,
          matched_rule_ids_json TEXT NOT NULL,
          rule_package_version TEXT NOT NULL,
          rule_package_hash TEXT NOT NULL,
          plan_id TEXT,
          plan_revision INTEGER,
          created_at TEXT NOT NULL,
          UNIQUE(session_id, decision_sequence)
        ) STRICT;

        -- 反馈只用于质量分析，不自动修改规则或发布状态。
        CREATE TABLE IF NOT EXISTS agent_feedback (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL REFERENCES agent_conversations(id),
          decision_id TEXT,
          rating TEXT NOT NULL CHECK(rating IN ('helpful', 'unhelpful')),
          reason_encrypted TEXT,
          encryption_key_version TEXT NOT NULL,
          created_at TEXT NOT NULL
        ) STRICT;
      `);
    }
  },
  {
    version: "0009_admin_console",
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
  },
  {
    // 旧库升级（评审 C P0）：#135 时代的 admin_sessions 无 revoked_at/
    // revoked_reason 列，新代码 find/revoke 全部查询该列，缺列时
    // kangmin-admin 整体瘫痪（no such column → internal_error）。
    // 同时把 admins 表已有行回填到 admin_accounts（占位密码不可登录），
    // 使升级前签发的 dev admin 会话令牌继续有效（find JOIN admin_accounts）。
    version: "0010_admin_sessions_upgrade",
    apply: (connection) => {
      const sessionColumns = connection
        .prepare("PRAGMA table_info(admin_sessions)")
        .all() as unknown as Array<{ name: string }>;
      if (!sessionColumns.some((column) => column.name === "revoked_at")) {
        connection.exec("ALTER TABLE admin_sessions ADD COLUMN revoked_at TEXT");
      }
      if (!sessionColumns.some((column) => column.name === "revoked_reason")) {
        connection.exec(
          "ALTER TABLE admin_sessions ADD COLUMN revoked_reason TEXT"
        );
      }
      // development_subject 为 NULL 的行用 'dev-' || id 兜底：username 是
      // NOT NULL UNIQUE，INSERT OR IGNORE 会静默吞掉违约行导致回填缺失，
      // 进而使 0012 重建 admin_sessions 时 FK 违约整库回滚（升级变砖）。
      connection.exec(`
        INSERT OR IGNORE INTO admin_accounts(
          id, username, password_hash, role, status,
          revision, created_at, updated_at
        )
        SELECT id, COALESCE(development_subject, 'dev-' || id), '!dev-session-only', role,
               CASE WHEN enabled = 1 THEN 'active' ELSE 'disabled' END,
               1, created_at, created_at
        FROM admins
        WHERE NOT EXISTS (
          SELECT 1 FROM admin_accounts WHERE admin_accounts.id = admins.id
        );
      `);
    }
  },
  {
    // admins 镜像消除（评审 A P1-5）：admin_idempotency 外键从废弃的
    // admins 表改指 admin_accounts(id)，消除双写镜像的最后一个结构性理由。
    // admins 表本身不 DROP：极旧升级库的 admin_sessions 仍可能引用它，
    // DROP 会造成升级库 FK 断裂；自本迁移起所有代码停止读写 admins
    // （0010 的回填继续保留，供 #135 时代旧库升级）。
    // 重建采用 CREATE new → 复制 → DROP → RENAME，与迁移账本同事务，
    // 失败自动回滚；开头 DROP TABLE IF EXISTS admin_idempotency_new
    // 保证失败重试幂等。
    version: "0011_admin_idempotency_fk",
    apply: (connection) => {
      connection.exec("DROP TABLE IF EXISTS admin_idempotency_new");
      connection.exec(`
        CREATE TABLE admin_idempotency_new (
          admin_id TEXT NOT NULL REFERENCES admin_accounts(id),
          scope TEXT NOT NULL,
          idempotency_key TEXT NOT NULL,
          request_hash TEXT NOT NULL,
          result_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY(admin_id, scope, idempotency_key)
        ) STRICT;
      `);
      // 极旧库（#135 形态，迁移账本标记 0004 已应用但无本表）不复制，
      // 仅完成建表；其余库全部数据搬移后交换表名。
      const hasIdempotency = connection.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'admin_idempotency'"
      ).get() !== undefined;
      if (hasIdempotency) {
        connection.exec(`
          INSERT INTO admin_idempotency_new(
            admin_id, scope, idempotency_key, request_hash, result_json, created_at
          )
          SELECT admin_id, scope, idempotency_key, request_hash, result_json, created_at
          FROM admin_idempotency;
          DROP TABLE admin_idempotency;
        `);
      }
      connection.exec(
        "ALTER TABLE admin_idempotency_new RENAME TO admin_idempotency"
      );
    }
  },
  {
    // #135 旧库残留（评审 A P1-5 收尾）：0011 只改了 admin_idempotency 的
    // FK，admin_sessions 的外键仍指向已废弃的 admins 表。升级后新管理员
    // 只写 admin_accounts（0010 回填的是旧行），再建会话时 FK 违约。
    // 本迁移用 PRAGMA foreign_key_list 检测：指向 admins（#135 形态）则
    // 重建 admin_sessions 使 FK 指向 admin_accounts(id)，并保留 0010 补的
    // revoked 列与 0003 的 admin_sessions_admin 索引；已是 admin_accounts
    // 形态（全新库）直接跳过，幂等。admins 表本身不 DROP（极旧库可能
    // 还有其他历史引用）。重建沿用 CREATE new → 复制 → DROP → RENAME，
    // 与迁移账本同事务，失败自动回滚。
    version: "0012_admin_sessions_fk",
    apply: (connection) => {
      const foreignKeys = connection
        .prepare("PRAGMA foreign_key_list(admin_sessions)")
        .all() as unknown as Array<{ table: string }>;
      if (!foreignKeys.some((key) => key.table === "admins")) {
        return; // 新库或无表：FK 已指向 admin_accounts，无需重建
      }
      // 复制前检测孤儿会话：admin_id 不在 admin_accounts（0010 回填缺失或
      // 数据本身损坏）时，复制必然 FK 违约并回滚整库。这里在复制前抛出
      // 明确错误，说明先跑 0010 或修复数据，而不是留下晦涩的违约回滚。
      const orphans = connection.prepare(`
        SELECT admin_id FROM admin_sessions
        WHERE admin_id NOT IN (SELECT id FROM admin_accounts)
        ORDER BY admin_id ASC LIMIT 5
      `).all() as unknown as Array<{ admin_id: string }>;
      if (orphans.length > 0) {
        throw new DomainError(
          "config_missing",
          `admin_sessions 存在孤儿会话（admin_id 不在 admin_accounts，如 ${orphans.map((row) => row.admin_id).join("、")}）：请先应用 0010 回填迁移或修复数据后再升级`
        );
      }
      connection.exec("DROP TABLE IF EXISTS admin_sessions_new");
      connection.exec(`
        CREATE TABLE admin_sessions_new (
          token_hash TEXT PRIMARY KEY,
          admin_id TEXT NOT NULL REFERENCES admin_accounts(id),
          expires_at TEXT NOT NULL,
          created_at TEXT NOT NULL,
          revoked_at TEXT,
          revoked_reason TEXT
        ) STRICT;
      `);
      connection.exec(`
        INSERT INTO admin_sessions_new(
          token_hash, admin_id, expires_at, created_at, revoked_at, revoked_reason
        )
        SELECT token_hash, admin_id, expires_at, created_at, revoked_at, revoked_reason
        FROM admin_sessions;
        DROP TABLE admin_sessions;
      `);
      connection.exec(
        "ALTER TABLE admin_sessions_new RENAME TO admin_sessions"
      );
      connection.exec(
        "CREATE INDEX IF NOT EXISTS admin_sessions_admin ON admin_sessions(admin_id)"
      );
    }
  },
  {
    // 模型 API Key 落地加密（外部评审 P1-1）：agent_model_config.api_key
    // 从明文列迁移为自包含密文 JSON + encryption_key_version（与健康正文
    // 同格式）。已有明文密钥在同一迁移内用当前密钥加密回填；存在明文但
    // 未提供加密端口时抛 config_missing（绝不静默丢失或留明文）。
    // 全新库 api_key 为 NULL，无需回填，迁移直接补列通过。
    version: "0013_agent_model_api_key_encryption",
    apply: (connection, encryption) => {
      // 防御性跳过：0009 未建表（异常/手工库）时无明文可回填，不误伤升级。
      const table = connection.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'agent_model_config'"
      ).get();
      if (table === undefined) {
        return;
      }
      const columns = connection
        .prepare("PRAGMA table_info(agent_model_config)")
        .all() as unknown as Array<{ name: string }>;
      if (
        !columns.some((column) => column.name === "encryption_key_version")
      ) {
        connection.exec(
          "ALTER TABLE agent_model_config ADD COLUMN encryption_key_version TEXT"
        );
      }
      backfillEncryptedColumn(
        connection,
        "agent_model_config", "api_key",
        "agent_model_config", "api_key", "id",
        encryption
      );
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
      // DomainError（如迁移回填缺密钥的 config_missing）原样透传，
      // 不得重包为 storage_unavailable 误导排障（评审 B P2）。
      if (error instanceof DomainError) {
        throw error;
      }
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
