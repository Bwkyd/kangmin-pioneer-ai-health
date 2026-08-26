import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync, type StatementSync } from "node:sqlite";

import { DomainError } from "../kernel/errors.js";
import type { EncryptionPort } from "../kernel/encryption.js";
import {
  CONTENT_CATEGORY_REGISTRY,
  VIDEO_TRUTH_ASSIGNMENTS
} from "../modules/admin/content-category-registry.js";
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
  },
  {
    // 媒体交付链（issue-151）：cover_url/media_url 改为公开媒体路由
    // /v1/media/<med_id>（发布时由仓储 UPDATE 写入），旧库已落对象键
    // 裸键（stored_path）的存量在此一次性改写；cover_media_id/media_id
    // 为 NULL 的行不触碰（自由文本/外链 URL 保持原值）。
    version: "0014_content_media_public_urls",
    apply: (connection) => {
      // 防御性跳过：手工/异常库无 content_items（与 0013 同款模式），
      // 不误伤升级。
      const table = connection.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'content_items'"
      ).get();
      if (table === undefined) {
        return;
      }
      connection.exec(`
        UPDATE content_items SET cover_url = '/v1/media/' || cover_media_id
        WHERE cover_media_id IS NOT NULL;
        UPDATE content_items SET media_url = '/v1/media/' || media_id
        WHERE media_id IS NOT NULL;
      `);
    }
  },
  {
    // consent 扩 5 类 + patient_consents 单列 id（issue-155）：SQLite 修改
    // CHECK 约束只能重建表；id 供 agent_conversations.save_consent_id 引用
    // 真实授权记录（旧 CHECK 只有 privacy/medical_boundary 两类）。
    version: "0015_consent_expansion",
    apply: (connection) => {
      // 防御性跳过：手工/异常库无 patient_consents（与 0013/0014 同款模式），
      // 不误伤升级。
      const table = connection.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'patient_consents'"
      ).get();
      if (table === undefined) {
        return;
      }
      connection.exec(`
        CREATE TABLE patient_consents_new (
          id TEXT NOT NULL,
          patient_id TEXT NOT NULL REFERENCES patients(id),
          consent_type TEXT NOT NULL
            CHECK(consent_type IN ('privacy', 'medical_boundary', 'health_data',
                                   'agent_session_save', 'location')),
          sequence INTEGER NOT NULL CHECK(sequence >= 1),
          decision TEXT NOT NULL
            CHECK(decision IN ('granted', 'withdrawn')),
          policy_version TEXT NOT NULL,
          request_id TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY(patient_id, consent_type, sequence)
        ) STRICT;

        -- 既有行回填确定性 id：主键（patient_id, consent_type, sequence）
        -- 唯一 ⇒ 派生 id 唯一。
        INSERT INTO patient_consents_new(
          id, patient_id, consent_type, sequence, decision,
          policy_version, request_id, created_at
        )
        SELECT patient_id || ':' || consent_type || ':' || sequence,
          patient_id, consent_type, sequence, decision,
          policy_version, request_id, created_at
        FROM patient_consents;

        DROP TABLE patient_consents;
        ALTER TABLE patient_consents_new RENAME TO patient_consents;

        CREATE INDEX patient_consents_latest
        ON patient_consents(patient_id, consent_type, sequence DESC);
        CREATE UNIQUE INDEX patient_consents_id ON patient_consents(id);
      `);
    }
  },
  {
    // 智能体设计改造：新流水线阶段 screening/phase（智能体设计 v4 二节）。
    // SQLite 无法 ALTER CHECK，按 0010 先例重建表：新 CHECK 加两个阶段，
    // 新增 phase_code/audience/rule_package_status 列（一律可空，回滚兼容；
    // 旧代码只 SELECT 旧列不受影响，见 docs/reviews/004 二轮 P0-1）。
    // 可行性已由有界实验验证（_work/20260809-bounded-slice/migration-rebuild.mjs）。
    version: "0011_agent_decisions_stages",
    apply: (connection) => {
      // 防御性跳过：账本标记 0008 已应用但表不存在（异常/手工库）时
      // 只建新结构，不误伤升级（同 0010 的防御先例）。
      const hasOldTable =
        connection
          .prepare(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'agent_decisions'"
          )
          .get() !== undefined;
      const copyOld =
        hasOldTable
          ? `
        INSERT INTO agent_decisions_new (id, session_id, decision_sequence,
          session_revision, input_snapshot_encrypted, input_snapshot_hash,
          outcome, stage, severity_code, syndrome_code, next_questions_json,
          matched_rule_ids_json, rule_package_version, rule_package_hash,
          plan_id, plan_revision, created_at)
          SELECT id, session_id, decision_sequence, session_revision,
          input_snapshot_encrypted, input_snapshot_hash, outcome, stage,
          severity_code, syndrome_code, next_questions_json,
          matched_rule_ids_json, rule_package_version, rule_package_hash,
          plan_id, plan_revision, created_at FROM agent_decisions;

        DROP TABLE agent_decisions;
        ALTER TABLE agent_decisions_new RENAME TO agent_decisions;`
          : `
        ALTER TABLE agent_decisions_new RENAME TO agent_decisions;`;
      connection.exec(`
        CREATE TABLE agent_decisions_new (
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
            CHECK(stage IN ('safety', 'screening', 'phase', 'applicability',
                            'severity', 'syndrome', 'plan_safety', 'completed')),
          severity_code TEXT,
          syndrome_code TEXT,
          phase_code TEXT,
          audience TEXT,
          rule_package_status TEXT,
          next_questions_json TEXT NOT NULL,
          matched_rule_ids_json TEXT NOT NULL,
          rule_package_version TEXT NOT NULL,
          rule_package_hash TEXT NOT NULL,
          plan_id TEXT,
          plan_revision INTEGER,
          created_at TEXT NOT NULL,
          UNIQUE(session_id, decision_sequence)
        ) STRICT;
      `);
      connection.exec(copyOld);
    }
  },
  {
    // 智能体设计改造：agent_plans 按期别×人群检索（评审 codex P0-1）。
    // 新增 phase_code（'acute'=急性期方案，NULL=调体方案）与 audience
    // （'adult'/'child'）两列；SQLite ADD COLUMN 幂等，旧行两列均为
    // NULL（回滚兼容：旧查询 SELECT 不受影响）。
    version: "0012_agent_plans_phase_audience",
    apply: (connection) => {
      // 防御性跳过：账本标记 0009 已应用但表不存在（异常/手工库）时
      // 不触碰（同 0011 的防御先例）。
      const hasTable =
        connection
          .prepare(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'agent_plans'"
          )
          .get() !== undefined;
      if (!hasTable) {
        return;
      }
      const columns = connection
        .prepare("PRAGMA table_info(agent_plans)")
        .all() as unknown as Array<{ name: string }>;
      const has = (name: string): boolean =>
        columns.some((column) => column.name === name);
      if (!has("phase_code")) {
        connection.exec("ALTER TABLE agent_plans ADD COLUMN phase_code TEXT");
      }
      if (!has("audience")) {
        connection.exec("ALTER TABLE agent_plans ADD COLUMN audience TEXT");
      }
    }
  },
  {
    // 小程序站内消息已读回执：消息发布后面向全部登录患者可见，回执按
    // patient_id 隔离；删除患者或消息时级联删除，不保留孤立状态。
    version: "0016_patient_message_reads",
    apply: (connection) => {
      connection.exec(`
        CREATE TABLE IF NOT EXISTS patient_message_reads (
          message_id TEXT NOT NULL REFERENCES content_messages(id) ON DELETE CASCADE,
          patient_id TEXT NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
          read_at TEXT NOT NULL,
          PRIMARY KEY(message_id, patient_id)
        ) STRICT;

        CREATE INDEX IF NOT EXISTS patient_message_reads_patient
        ON patient_message_reads(patient_id, read_at DESC);
      `);
    }
  },
  {
    // 微信小程序身份只保存 AppID+OpenID 的不可逆摘要；原始 OpenID、
    // session_key 与 AppSecret 均不落库。
    version: "0017_patient_external_identities",
    apply: (connection) => {
      connection.exec(`
        CREATE TABLE IF NOT EXISTS patient_external_identities (
          provider TEXT NOT NULL CHECK(provider IN ('wechat_mini_program')),
          subject_hash TEXT NOT NULL,
          patient_id TEXT NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
          created_at TEXT NOT NULL,
          PRIMARY KEY(provider, subject_hash),
          UNIQUE(provider, patient_id)
        ) STRICT;
      `);
    }
  },
  {
    version: "0018_knowledge_category",
    apply: (connection) => {
      const hasTable = connection.prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'agent_knowledge_items'"
      ).get() !== undefined;
      if (!hasTable) return;
      const columns = connection.prepare("PRAGMA table_info(agent_knowledge_items)").all() as unknown as Array<{ name: string }>;
      if (!columns.some((column) => column.name === "category")) {
        connection.exec("ALTER TABLE agent_knowledge_items ADD COLUMN category TEXT");
      }
    }
  },
  {
    version: "0019_patient_assessment_context",
    apply: (connection) => {
      const hasConversations = connection.prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'agent_conversations'"
      ).get() !== undefined;
      if (!hasConversations) return;
      connection.exec(`
        CREATE TABLE IF NOT EXISTS agent_assessments (
          id TEXT PRIMARY KEY,
          patient_id TEXT NOT NULL REFERENCES patients(id),
          source_session_id TEXT NOT NULL REFERENCES agent_conversations(id),
          decision_id TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('current', 'superseded')),
          answers_snapshot_encrypted TEXT NOT NULL,
          answers_snapshot_hash TEXT NOT NULL,
          severity_code TEXT,
          syndrome_code TEXT NOT NULL,
          phase_code TEXT NOT NULL CHECK(phase_code IN ('acute', 'remission')),
          audience TEXT NOT NULL CHECK(audience IN ('child', 'adult')),
          plan_refs_json TEXT NOT NULL,
          rule_package_version TEXT NOT NULL,
          rule_package_hash TEXT NOT NULL,
          completed_at TEXT NOT NULL,
          superseded_at TEXT
        ) STRICT;
        CREATE INDEX IF NOT EXISTS agent_assessments_patient_current
          ON agent_assessments(patient_id, status, completed_at DESC);
        CREATE UNIQUE INDEX IF NOT EXISTS agent_assessments_one_current_per_patient
          ON agent_assessments(patient_id) WHERE status = 'current';
      `);
      const columns = connection.prepare("PRAGMA table_info(agent_conversations)")
        .all() as unknown as Array<{ name: string }>;
      if (!columns.some((column) => column.name === "assessment_id")) {
        connection.exec(
          "ALTER TABLE agent_conversations ADD COLUMN assessment_id TEXT"
        );
      }
    }
  },
  {
    version: "0020_knowledge_semantic_embeddings",
    apply: (connection) => {
      connection.exec(`
        CREATE TABLE IF NOT EXISTS agent_knowledge_embeddings (
          knowledge_id TEXT NOT NULL,
          chunk_index INTEGER NOT NULL CHECK(chunk_index >= 0),
          model_name TEXT NOT NULL,
          dimensions INTEGER NOT NULL CHECK(dimensions > 0),
          embedding BLOB NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY(knowledge_id, chunk_index),
          FOREIGN KEY(knowledge_id, chunk_index)
            REFERENCES agent_knowledge_chunks(knowledge_id, chunk_index)
            ON DELETE CASCADE
        ) STRICT;
        CREATE INDEX IF NOT EXISTS agent_knowledge_embeddings_model
          ON agent_knowledge_embeddings(model_name, dimensions);
      `);
    }
  },
  {
    // 知识目录只负责运营整理。旧 category 逐项迁成一级目录，知识正文、
    // 状态、分块和向量均不改动；category 保留为迁移来源兼容列，运行时
    // 展示路径由 folder_id 指向的目录树实时派生。
    version: "0021_knowledge_folders",
    apply: (connection) => {
      connection.exec(`
        CREATE TABLE IF NOT EXISTS agent_knowledge_folders (
          id TEXT PRIMARY KEY,
          parent_id TEXT REFERENCES agent_knowledge_folders(id) ON DELETE RESTRICT,
          name TEXT NOT NULL CHECK(length(trim(name)) > 0),
          sort_order INTEGER NOT NULL DEFAULT 0 CHECK(sort_order >= 0),
          created_by TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT;

        CREATE UNIQUE INDEX IF NOT EXISTS agent_knowledge_folders_root_name
        ON agent_knowledge_folders(name) WHERE parent_id IS NULL;

        CREATE UNIQUE INDEX IF NOT EXISTS agent_knowledge_folders_sibling_name
        ON agent_knowledge_folders(parent_id, name) WHERE parent_id IS NOT NULL;
      `);
      const hasKnowledgeItems = connection.prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'agent_knowledge_items'"
      ).get() !== undefined;
      if (!hasKnowledgeItems) return;
      const columns = connection.prepare("PRAGMA table_info(agent_knowledge_items)").all() as unknown as Array<{ name: string }>;
      if (!columns.some((column) => column.name === "folder_id")) {
        connection.exec("ALTER TABLE agent_knowledge_items ADD COLUMN folder_id TEXT REFERENCES agent_knowledge_folders(id) ON DELETE RESTRICT");
      }
      const categories = connection.prepare(`
        SELECT category, MIN(created_at) AS created_at, MAX(updated_at) AS updated_at
        FROM agent_knowledge_items
        WHERE category IS NOT NULL AND trim(category) <> ''
        GROUP BY category
        ORDER BY category ASC
      `).all() as unknown as Array<{ category: string; created_at: string; updated_at: string }>;
      const insert = connection.prepare(`
        INSERT OR IGNORE INTO agent_knowledge_folders(
          id, parent_id, name, sort_order, created_by, created_at, updated_at
        ) VALUES (?, NULL, ?, ?, NULL, ?, ?)
      `);
      const assign = connection.prepare(`
        UPDATE agent_knowledge_items SET folder_id = ?
        WHERE folder_id IS NULL AND category = ?
      `);
      categories.forEach((row, index) => {
        const id = `kfd_legacy_${createHash("sha256").update(row.category).digest("hex").slice(0, 12)}`;
        insert.run(id, row.category, index, row.created_at, row.updated_at);
        assign.run(id, row.category);
      });
      connection.exec(`
        CREATE INDEX IF NOT EXISTS agent_knowledge_items_folder
        ON agent_knowledge_items(folder_id, updated_at DESC);
      `);
    }
  },
  {
    // 患者内容分类注册表：稳定 ID、父子树、人群和可选叶节点为权威；
    // 旧 content_categories/category 字符串暂留兼容，不再作为新关联键。
    // 视频种子和标题关联只编译自 vault/truth/视频大全.md；作者确认文章
    // 只有“科普文章”一个分类，因此全部存量文章都存在唯一、安全映射。
    version: "0022_content_category_registry",
    apply: (connection) => {
      connection.exec(`
        CREATE TABLE IF NOT EXISTS content_category_registry (
          id TEXT PRIMARY KEY,
          kind TEXT NOT NULL CHECK(kind IN ('article', 'video')),
          parent_id TEXT REFERENCES content_category_registry(id) ON DELETE RESTRICT,
          name TEXT NOT NULL CHECK(length(trim(name)) > 0),
          audience TEXT NOT NULL CHECK(audience IN ('adult', 'child', 'all')),
          node_type TEXT NOT NULL CHECK(node_type IN ('audience', 'group', 'leaf')),
          selectable INTEGER NOT NULL CHECK(selectable IN (0, 1)),
          display_order INTEGER NOT NULL DEFAULT 0 CHECK(display_order >= 0),
          status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'disabled')),
          revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          CHECK((node_type = 'leaf' AND selectable = 1) OR selectable = 0)
        ) STRICT;

        CREATE UNIQUE INDEX IF NOT EXISTS content_category_registry_root_name
        ON content_category_registry(kind, name) WHERE parent_id IS NULL;
        CREATE UNIQUE INDEX IF NOT EXISTS content_category_registry_sibling_name
        ON content_category_registry(kind, parent_id, name) WHERE parent_id IS NOT NULL;
        CREATE INDEX IF NOT EXISTS content_category_registry_tree
        ON content_category_registry(kind, parent_id, display_order, id);

        CREATE TABLE IF NOT EXISTS content_item_category_links (
          content_id TEXT NOT NULL REFERENCES content_items(id) ON DELETE CASCADE,
          category_id TEXT NOT NULL REFERENCES content_category_registry(id) ON DELETE RESTRICT,
          created_at TEXT NOT NULL,
          PRIMARY KEY(content_id, category_id)
        ) STRICT;
        CREATE INDEX IF NOT EXISTS content_item_category_links_category
        ON content_item_category_links(category_id, content_id);

        CREATE TABLE IF NOT EXISTS content_category_migration_report (
          content_id TEXT PRIMARY KEY REFERENCES content_items(id) ON DELETE CASCADE,
          kind TEXT NOT NULL CHECK(kind IN ('article', 'video')),
          title TEXT NOT NULL,
          legacy_category TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('migrated', 'unresolved')),
          reason TEXT NOT NULL,
          category_ids_json TEXT NOT NULL,
          created_at TEXT NOT NULL
        ) STRICT;
      `);

      const timestamp = "2026-08-26T00:00:00.000Z";
      const insertCategory = connection.prepare(`
        INSERT OR IGNORE INTO content_category_registry(
          id, kind, parent_id, name, audience, node_type, selectable,
          display_order, status, revision, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', 1, ?, ?)
      `);
      for (const category of CONTENT_CATEGORY_REGISTRY) {
        insertCategory.run(
          category.id,
          category.kind,
          category.parentId,
          category.name,
          category.audience,
          category.nodeType,
          category.selectable ? 1 : 0,
          category.displayOrder,
          timestamp,
          timestamp
        );
      }

      // 极早期账号-only 数据库可能没有 content_items。此时仍建立并
      // 填充分类注册表，但不能把“没有内容表”误判成存储整体不可用。
      const hasContentItems = connection.prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'content_items'"
      ).get() !== undefined;
      if (!hasContentItems) return;

      const assignments = new Map(
        VIDEO_TRUTH_ASSIGNMENTS.map((item) => [item.title, item.categoryIds])
      );
      const rows = connection.prepare(`
        SELECT id, kind, title, category
        FROM content_items
        WHERE kind IN ('article', 'video')
        ORDER BY id ASC
      `).all() as unknown as Array<{
        id: string;
        kind: "article" | "video";
        title: string;
        category: string;
      }>;
      const link = connection.prepare(`
        INSERT OR IGNORE INTO content_item_category_links(content_id, category_id, created_at)
        VALUES (?, ?, ?)
      `);
      const report = connection.prepare(`
        INSERT OR REPLACE INTO content_category_migration_report(
          content_id, kind, title, legacy_category, status, reason,
          category_ids_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const row of rows) {
        const categoryIds = row.kind === "video"
          ? assignments.get(row.title.trim())
          : ["article-general"];
        if (categoryIds !== undefined && categoryIds.length > 0) {
          for (const categoryId of categoryIds) {
            link.run(row.id, categoryId, timestamp);
          }
          report.run(
            row.id,
            row.kind,
            row.title,
            row.category,
            "migrated",
            row.kind === "video" ? "video_truth_exact_title" : "article_single_confirmed_category",
            JSON.stringify(categoryIds),
            timestamp
          );
          continue;
        }
        report.run(
          row.id,
          row.kind,
          row.title,
          row.category,
          "unresolved",
          row.kind === "article" ? "article_legacy_category_unmatched" : "video_title_not_in_truth",
          "[]",
          timestamp
        );
      }
      // 无法唯一匹配的存量内容必须 fail-closed：保留内容与报告供人工
      // 选择，但不允许旧发布状态绕过新分类门禁继续对患者直达可见。
      connection.prepare(`
        UPDATE content_items
        SET status = 'unpublished', patient_visible = 0,
            published_at = NULL, updated_at = ?
        WHERE id IN (
          SELECT content_id FROM content_category_migration_report
          WHERE status = 'unresolved'
        ) AND status = 'published'
      `).run(timestamp);
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
