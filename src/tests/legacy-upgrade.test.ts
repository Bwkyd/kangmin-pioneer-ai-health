import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { appliedMigrationVersions, KangminDatabase } from "@kangmin/database/sqlite/database";
import { DomainError } from "@kangmin/core/kernel/errors";
import {
  AesGcmEncryption,
  parseEncryptionKeys
} from "../infrastructure/aes-gcm-encryption.js";
import { decryptStoredField } from "@kangmin/database/shared/encrypted-fields";

// 测试进程以本地开发模式启动（明文开发实现，避免密钥配置）。
process.env.KANGMIN_ALLOW_DEV_SESSION = "1";

/**
 * 旧库升级（评审 C P0 回归测试）：#135 时代的库有 admins 表与
 * 无 revoked 列的 admin_sessions，但无 admin_accounts 行。
 * 新代码打开旧库必须：补 revoked 列 + 回填 admin_accounts，
 * 否则 kangmin-admin 整体瘫痪（no such column → internal_error）。
 */
function createLegacyDatabase(path: string): void {
  const connection = new DatabaseSync(path);
  connection.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE schema_migrations (
      version TEXT PRIMARY KEY, applied_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE admins (
      id TEXT PRIMARY KEY, development_subject TEXT UNIQUE,
      role TEXT NOT NULL CHECK(role IN ('owner', 'admin')),
      enabled INTEGER NOT NULL CHECK(enabled IN (0, 1)), created_at TEXT NOT NULL
    ) STRICT;
    -- #135 时代的 admin_sessions：无 revoked_at/revoked_reason。
    CREATE TABLE admin_sessions (
      token_hash TEXT PRIMARY KEY,
      admin_id TEXT NOT NULL REFERENCES admins(id),
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE admin_accounts (
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
    INSERT INTO schema_migrations(version, applied_at)
    VALUES
      ('0001_patient_record_baseline', '2026-08-01T00:00:00Z'),
      ('0002_system_ledger', '2026-08-01T00:00:00Z'),
      ('0003_identity', '2026-08-01T00:00:00Z'),
      ('0004_origin_main_tables', '2026-08-01T00:00:00Z'),
      ('0005_record_encryption_soft_delete', '2026-08-01T00:00:00Z'),
      ('0006_account_sessions_and_consents', '2026-08-01T00:00:00Z'),
      ('0007_browse_environment_plans', '2026-08-01T00:00:00Z'),
      ('0008_agent_conversations', '2026-08-01T00:00:00Z'),
      ('0009_admin_console', '2026-08-01T00:00:00Z');
    -- #135 已签发的 dev admin 会话（升级前令牌必须继续有效）。
    INSERT INTO admins(id, development_subject, role, enabled, created_at)
    VALUES ('admin-legacy', 'legacy-dev-admin', 'owner', 1, '2026-08-01T00:00:00Z');
    INSERT INTO admin_sessions(token_hash, admin_id, expires_at, created_at)
    VALUES ('legacy-token-hash', 'admin-legacy',
            '2099-01-01T00:00:00Z', '2026-08-01T00:00:00Z');
  `);
  connection.close();
}

test("旧库升级：补 revoked 列并回填 admin_accounts，旧 dev admin 会话继续有效", () => {
  const directory = mkdtempSync(join(tmpdir(), "kangmin-upgrade-"));
  const databasePath = join(directory, "legacy.sqlite");
  createLegacyDatabase(databasePath);

  const database = new KangminDatabase(databasePath);
  try {
    const columns = database.connection
      .prepare("PRAGMA table_info(admin_sessions)")
      .all() as unknown as Array<{ name: string }>;
    const names = columns.map((column) => column.name);
    assert.ok(names.includes("revoked_at"), "0010 应补 revoked_at 列");
    assert.ok(
      names.includes("revoked_reason"),
      "0010 应补 revoked_reason 列"
    );

    // admins 行已回填 admin_accounts，旧会话 find 的 JOIN 可命中。
    const account = database.connection
      .prepare("SELECT id, role, status FROM admin_accounts WHERE id = ?")
      .get("admin-legacy") as unknown as
      | { id: string; role: string; status: string }
      | undefined;
    assert.notEqual(account, undefined, "admins 行应回填 admin_accounts");
    assert.equal(account?.role, "owner");
    assert.equal(account?.status, "active");

    // 回填幂等：再次打开不重复插入（INSERT OR IGNORE）。
    const count = database.connection
      .prepare("SELECT COUNT(*) AS count FROM admin_accounts")
      .get() as unknown as { count: number };
    assert.equal(count.count, 1);
  } finally {
    database.close();
  }
});

test("全新库迁移 0010 幂等：无 admins 行时不产生空回填", () => {
  const directory = mkdtempSync(join(tmpdir(), "kangmin-fresh-"));
  const database = new KangminDatabase(join(directory, "fresh.sqlite"));
  try {
    const count = database.connection
      .prepare("SELECT COUNT(*) AS count FROM admin_accounts")
      .get() as unknown as { count: number };
    assert.equal(count.count, 0);
    const versions = database.connection
      .prepare("SELECT version FROM schema_migrations ORDER BY version")
      .all() as unknown as Array<{ version: string }>;
    assert.ok(
      versions.some((row) => row.version === "0010_admin_sessions_upgrade")
    );
  } finally {
    database.close();
  }
});

/** 0005 之前的旧库形态（评审 C P0/升级路径 P0）：明文记录表 + 明文
 * medication_name，且已有真实用药数据；0006-0012 依赖的会话/账号/
 * 内容表一并按旧形态建好，保证升级能一路走到 0012。 */
function createLegacyRecordDatabase(path: string): void {
  const connection = new DatabaseSync(path);
  connection.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE schema_migrations (
      version TEXT PRIMARY KEY, applied_at TEXT NOT NULL
    ) STRICT;
    INSERT INTO schema_migrations(version, applied_at) VALUES
      ('0001_patient_record_baseline', '2026-08-01T00:00:00Z'),
      ('0002_system_ledger', '2026-08-01T00:00:00Z'),
      ('0003_identity', '2026-08-01T00:00:00Z'),
      ('0004_origin_main_tables', '2026-08-01T00:00:00Z');

    CREATE TABLE patients (
      id TEXT PRIMARY KEY, development_subject TEXT UNIQUE,
      created_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE patient_sessions (
      token_hash TEXT PRIMARY KEY,
      patient_id TEXT NOT NULL REFERENCES patients(id),
      expires_at TEXT NOT NULL, created_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE symptom_records (
      id TEXT PRIMARY KEY,
      patient_id TEXT NOT NULL REFERENCES patients(id),
      local_date TEXT NOT NULL,
      nasal_congestion INTEGER NOT NULL CHECK(nasal_congestion BETWEEN 0 AND 3),
      nasal_itching INTEGER NOT NULL CHECK(nasal_itching BETWEEN 0 AND 3),
      sneezing INTEGER NOT NULL CHECK(sneezing BETWEEN 0 AND 3),
      runny_nose INTEGER NOT NULL CHECK(runny_nose BETWEEN 0 AND 3),
      tnss_total INTEGER NOT NULL CHECK(tnss_total BETWEEN 0 AND 12),
      notes TEXT, revision INTEGER NOT NULL CHECK(revision >= 1),
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE(patient_id, local_date)
    ) STRICT;
    CREATE TABLE exposure_records (
      id TEXT PRIMARY KEY,
      patient_id TEXT NOT NULL REFERENCES patients(id),
      local_date TEXT NOT NULL, factors_json TEXT NOT NULL,
      other_description TEXT, notes TEXT,
      revision INTEGER NOT NULL CHECK(revision >= 1),
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE(patient_id, local_date)
    ) STRICT;
    CREATE TABLE medication_records (
      id TEXT PRIMARY KEY,
      patient_id TEXT NOT NULL REFERENCES patients(id),
      local_date TEXT NOT NULL,
      medication_name TEXT NOT NULL,
      dosage TEXT, actual_use TEXT, notes TEXT,
      revision INTEGER NOT NULL CHECK(revision >= 1),
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE profiles (
      patient_id TEXT PRIMARY KEY REFERENCES patients(id),
      display_name TEXT, birth_date TEXT,
      sex TEXT NOT NULL DEFAULT 'unspecified'
        CHECK(sex IN ('female', 'male', 'other', 'unspecified')),
      allergy_history TEXT, known_allergies TEXT,
      common_triggers TEXT, notes TEXT,
      revision INTEGER NOT NULL CHECK(revision >= 1),
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE patient_accounts (
      patient_id TEXT PRIMARY KEY REFERENCES patients(id),
      username_hash TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active'
        CHECK(status IN ('active', 'deactivated', 'deletion_pending')),
      nickname TEXT, revision INTEGER NOT NULL CHECK(revision >= 1),
      last_active_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE content_items (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK(kind IN ('article', 'video')),
      title TEXT NOT NULL, category TEXT NOT NULL,
      summary TEXT NOT NULL, body TEXT,
      source TEXT NOT NULL, cover_url TEXT, media_url TEXT,
      status TEXT NOT NULL
        CHECK(status IN ('draft', 'review', 'published', 'unpublished', 'failed')),
      patient_visible INTEGER NOT NULL CHECK(patient_visible IN (0, 1)),
      version_valid INTEGER NOT NULL CHECK(version_valid IN (0, 1)),
      media_available INTEGER NOT NULL CHECK(media_available IN (0, 1)),
      published_at TEXT, updated_at TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1),
      created_by TEXT
    ) STRICT;
    CREATE TABLE admins (
      id TEXT PRIMARY KEY, development_subject TEXT UNIQUE,
      role TEXT NOT NULL CHECK(role IN ('owner', 'admin')),
      enabled INTEGER NOT NULL CHECK(enabled IN (0, 1)), created_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE admin_accounts (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('owner', 'admin')),
      status TEXT NOT NULL DEFAULT 'active'
        CHECK(status IN ('active', 'disabled')),
      revision INTEGER NOT NULL CHECK(revision >= 1),
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE admin_sessions (
      token_hash TEXT PRIMARY KEY,
      admin_id TEXT NOT NULL REFERENCES admins(id),
      expires_at TEXT NOT NULL, created_at TEXT NOT NULL
    ) STRICT;
    INSERT INTO admins(id, development_subject, role, enabled, created_at)
    VALUES ('admin-legacy', 'legacy-dev-admin', 'owner', 1, '2026-08-01T00:00:00Z');

    INSERT INTO patients(id, development_subject, created_at)
    VALUES ('patient-1', 'legacy-patient', '2026-08-01T00:00:00Z');
    INSERT INTO symptom_records(
      id, patient_id, local_date, nasal_congestion, nasal_itching,
      sneezing, runny_nose, tnss_total, notes, revision, created_at, updated_at
    ) VALUES (
      'symptom-1', 'patient-1', '2026-07-30',
      2, 1, 3, 2, 8, '夜间鼻塞明显', 1,
      '2026-07-30T00:00:00Z', '2026-07-30T00:00:00Z'
    );
    INSERT INTO exposure_records(
      id, patient_id, local_date, factors_json, other_description,
      notes, revision, created_at, updated_at
    ) VALUES (
      'exposure-1', 'patient-1', '2026-07-30',
      '["dust_mite","pollen"]', '接触灰尘加重', '户外运动后加重', 1,
      '2026-07-30T00:00:00Z', '2026-07-30T00:00:00Z'
    );
    INSERT INTO medication_records(
      id, patient_id, local_date, medication_name, dosage,
      actual_use, notes, revision, created_at, updated_at
    ) VALUES (
      'medication-1', 'patient-1', '2026-07-30',
      '氯雷他定片', '每晚 1 片', '已服用两周', '医生开具', 1,
      '2026-07-30T00:00:00Z', '2026-07-30T00:00:00Z'
    );
    INSERT INTO profiles(
      patient_id, display_name, birth_date, sex, allergy_history,
      known_allergies, common_triggers, notes, revision, created_at, updated_at
    ) VALUES (
      'patient-1', '测试患者', '1990-01-01', 'unspecified',
      '无', '尘螨', '灰尘、花粉', '体质偏寒', 1,
      '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z'
    );
  `);
  connection.close();
}

test("旧库含用药记录：0005 迁移不违约，用药数据加密回填可读，0005-0012 全部应用", () => {
  const directory = mkdtempSync(join(tmpdir(), "kangmin-upgrade-med-"));
  const databasePath = join(directory, "legacy.sqlite");
  createLegacyRecordDatabase(databasePath);

  const KEY = Buffer.alloc(32, 3).toString("base64");
  const encryption = new AesGcmEncryption(parseEncryptionKeys(`v1:${KEY}`));
  const database = new KangminDatabase(databasePath, encryption);
  try {
    const versions = appliedMigrationVersions(database);
    for (const version of [
      "0005_record_encryption_soft_delete",
      "0006_account_sessions_and_consents",
      "0007_browse_environment_plans",
      "0008_agent_conversations",
      "0009_admin_console",
      "0010_admin_sessions_upgrade",
      "0011_admin_idempotency_fk",
      "0012_admin_sessions_fk"
    ]) {
      assert.ok(versions.includes(version), `${version} 应已应用`);
    }

    // 用药记录回填：占位空串已被真实密文覆盖，可解密读回。
    const medication = database.connection
      .prepare(`
        SELECT medication_name_encrypted, dosage_encrypted,
               encryption_key_version
        FROM medication_records WHERE id = 'medication-1'
      `)
      .get() as unknown as {
      medication_name_encrypted: string;
      dosage_encrypted: string | null;
      encryption_key_version: string | null;
    };
    assert.ok(
      medication.medication_name_encrypted.length > 0,
      "medication_name_encrypted 应被回填为密文而非占位空串"
    );
    assert.equal(medication.encryption_key_version, "v1");
    assert.equal(
      decryptStoredField(
        encryption,
        medication.medication_name_encrypted,
        medication.encryption_key_version,
        "用药名称"
      ),
      "氯雷他定片"
    );
    assert.equal(
      decryptStoredField(
        encryption,
        medication.dosage_encrypted,
        medication.encryption_key_version,
        "用药剂量"
      ),
      "每晚 1 片"
    );

    // 其他三类记录同迁移回填仍可读（症状/暴露/档案）。
    const symptom = database.connection
      .prepare(`
        SELECT notes_encrypted, encryption_key_version
        FROM symptom_records WHERE id = 'symptom-1'
      `)
      .get() as unknown as { notes_encrypted: string | null; encryption_key_version: string | null };
    assert.equal(
      decryptStoredField(
        encryption, symptom.notes_encrypted, symptom.encryption_key_version, "症状备注"
      ),
      "夜间鼻塞明显"
    );
    const exposure = database.connection
      .prepare(`
        SELECT other_description_encrypted, encryption_key_version
        FROM exposure_records WHERE id = 'exposure-1'
      `)
      .get() as unknown as { other_description_encrypted: string | null; encryption_key_version: string | null };
    assert.equal(
      decryptStoredField(
        encryption,
        exposure.other_description_encrypted,
        exposure.encryption_key_version,
        "暴露其他描述"
      ),
      "接触灰尘加重"
    );
    const profile = database.connection
      .prepare(`
        SELECT display_name_encrypted, encryption_key_version
        FROM profiles WHERE patient_id = 'patient-1'
      `)
      .get() as unknown as { display_name_encrypted: string | null; encryption_key_version: string | null };
    assert.equal(
      decryptStoredField(
        encryption,
        profile.display_name_encrypted,
        profile.encryption_key_version,
        "档案显示名"
      ),
      "测试患者"
    );
  } finally {
    database.close();
  }
});

test("旧库升级 0012：admin_sessions 外键改指 admin_accounts，新建管理员会话不 FK 违约", () => {
  const directory = mkdtempSync(join(tmpdir(), "kangmin-upgrade-fk-"));
  const databasePath = join(directory, "legacy.sqlite");
  createLegacyDatabase(databasePath);

  const database = new KangminDatabase(databasePath);
  try {
    // 升级后 admin_sessions 的全部外键目标必须是 admin_accounts（#135
    // 形态的 FK→admins 已被 0012 重建消除）。
    const foreignKeys = database.connection
      .prepare("PRAGMA foreign_key_list(admin_sessions)")
      .all() as unknown as Array<{ table: string }>;
    assert.ok(foreignKeys.length > 0, "admin_sessions 应有外键");
    assert.ok(
      foreignKeys.every((key) => key.table === "admin_accounts"),
      "0012 应把 admin_sessions 外键改指 admin_accounts"
    );

    // 旧会话数据复制保留，升级前令牌继续有效。
    const legacySession = database.connection
      .prepare("SELECT token_hash FROM admin_sessions WHERE token_hash = ?")
      .get("legacy-token-hash");
    assert.notEqual(legacySession, undefined, "0012 重建不应丢旧会话");

    // 新建 admin_accounts 行 + 新 admin_sessions 行：外键校验已开启，
    // 旧 FK→admins 形态下新管理员不在 admins 表必然违约，改指后必须通过。
    const now = "2026-08-01T12:00:00Z";
    database.connection
      .prepare(`
        INSERT INTO admin_accounts(
          id, username, password_hash, role, status,
          revision, created_at, updated_at
        ) VALUES (?, ?, ?, 'admin', 'active', 1, ?, ?)
      `)
      .run("admin-new", "new-admin", "x-placeholder", now, now);
    assert.doesNotThrow(() =>
      database.connection
        .prepare(`
          INSERT INTO admin_sessions(token_hash, admin_id, expires_at, created_at)
          VALUES (?, ?, ?, ?)
        `)
        .run("new-token-hash", "admin-new", "2099-01-01T00:00:00Z", now)
    );

    // 反向证明外键仍生效（指向 admin_accounts：不存在的管理员被拒绝）。
    assert.throws(
      () =>
        database.connection
          .prepare(`
            INSERT INTO admin_sessions(token_hash, admin_id, expires_at, created_at)
            VALUES (?, ?, ?, ?)
          `)
          .run("bogus-token-hash", "no-such-admin", "2099-01-01T00:00:00Z", now),
      /FOREIGN KEY constraint failed/
    );
  } finally {
    database.close();
  }
});

/**
 * development_subject 为 NULL 的 #135 旧库（外部评审 P1-5）：0010 的
 * INSERT OR IGNORE 会因 username NOT NULL 违约静默吞掉回填，导致 0012
 * 重建 admin_sessions 外键时复制违约整库回滚（升级变砖）。
 */
function createLegacyNullSubjectDatabase(path: string): void {
  const connection = new DatabaseSync(path);
  connection.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE schema_migrations (
      version TEXT PRIMARY KEY, applied_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE admins (
      id TEXT PRIMARY KEY, development_subject TEXT UNIQUE,
      role TEXT NOT NULL CHECK(role IN ('owner', 'admin')),
      enabled INTEGER NOT NULL CHECK(enabled IN (0, 1)), created_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE admin_sessions (
      token_hash TEXT PRIMARY KEY,
      admin_id TEXT NOT NULL REFERENCES admins(id),
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE admin_accounts (
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
    INSERT INTO schema_migrations(version, applied_at) VALUES
      ('0001_patient_record_baseline', '2026-08-01T00:00:00Z'),
      ('0002_system_ledger', '2026-08-01T00:00:00Z'),
      ('0003_identity', '2026-08-01T00:00:00Z'),
      ('0004_origin_main_tables', '2026-08-01T00:00:00Z'),
      ('0005_record_encryption_soft_delete', '2026-08-01T00:00:00Z'),
      ('0006_account_sessions_and_consents', '2026-08-01T00:00:00Z'),
      ('0007_browse_environment_plans', '2026-08-01T00:00:00Z'),
      ('0008_agent_conversations', '2026-08-01T00:00:00Z'),
      ('0009_admin_console', '2026-08-01T00:00:00Z');
    -- #135 时代的 admin：development_subject 可能为 NULL（占位数据）。
    INSERT INTO admins(id, development_subject, role, enabled, created_at)
    VALUES ('admin-null-subject', NULL, 'owner', 1, '2026-08-01T00:00:00Z');
    INSERT INTO admin_sessions(token_hash, admin_id, expires_at, created_at)
    VALUES ('null-subject-token-hash', 'admin-null-subject',
            '2099-01-01T00:00:00Z', '2026-08-01T00:00:00Z');
  `);
  connection.close();
}

test("旧库升级：admins 行 development_subject 为 NULL 时回填成功，0010-0012 全部应用", () => {
  const directory = mkdtempSync(join(tmpdir(), "kangmin-upgrade-null-"));
  const databasePath = join(directory, "legacy.sqlite");
  createLegacyNullSubjectDatabase(databasePath);

  const database = new KangminDatabase(databasePath);
  try {
    // 0010 用 COALESCE 兜底：NULL development_subject 回填为 'dev-' || id，
    // INSERT OR IGNORE 不再被 NOT NULL 违约吞掉。
    const account = database.connection
      .prepare("SELECT id, username FROM admin_accounts WHERE id = ?")
      .get("admin-null-subject") as unknown as
      | { id: string; username: string }
      | undefined;
    assert.notEqual(account, undefined, "NULL development_subject 行必须回填");
    assert.equal(account?.username, "dev-admin-null-subject");

    // 0012 复制不违约：旧会话保留，升级全程成功。
    const legacySession = database.connection
      .prepare("SELECT token_hash FROM admin_sessions WHERE token_hash = ?")
      .get("null-subject-token-hash");
    assert.notEqual(legacySession, undefined, "0012 重建不应丢旧会话");
    const versions = appliedMigrationVersions(database);
    assert.ok(versions.includes("0012_admin_sessions_fk"));
  } finally {
    database.close();
  }
});

/**
 * 0009 之后的旧库：agent_model_config 存在且 api_key 为明文（0013 前形态）。
 * 沿用 createLegacyDatabase 的 0010-0012 前置结构（admin_sessions/admins/
 * admin_accounts），保证 0010-0012 能一路跑到 0013。
 */
function createLegacyModelConfigDatabase(path: string): void {
  const connection = new DatabaseSync(path);
  connection.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE schema_migrations (
      version TEXT PRIMARY KEY, applied_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE admins (
      id TEXT PRIMARY KEY, development_subject TEXT UNIQUE,
      role TEXT NOT NULL CHECK(role IN ('owner', 'admin')),
      enabled INTEGER NOT NULL CHECK(enabled IN (0, 1)), created_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE admin_sessions (
      token_hash TEXT PRIMARY KEY,
      admin_id TEXT NOT NULL REFERENCES admins(id),
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE admin_accounts (
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
    CREATE TABLE agent_model_config (
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
    INSERT INTO schema_migrations(version, applied_at) VALUES
      ('0001_patient_record_baseline', '2026-08-01T00:00:00Z'),
      ('0002_system_ledger', '2026-08-01T00:00:00Z'),
      ('0003_identity', '2026-08-01T00:00:00Z'),
      ('0004_origin_main_tables', '2026-08-01T00:00:00Z'),
      ('0005_record_encryption_soft_delete', '2026-08-01T00:00:00Z'),
      ('0006_account_sessions_and_consents', '2026-08-01T00:00:00Z'),
      ('0007_browse_environment_plans', '2026-08-01T00:00:00Z'),
      ('0008_agent_conversations', '2026-08-01T00:00:00Z'),
      ('0009_admin_console', '2026-08-01T00:00:00Z');
    INSERT INTO admins(id, development_subject, role, enabled, created_at)
    VALUES ('admin-legacy', 'legacy-dev-admin', 'owner', 1, '2026-08-01T00:00:00Z');
    INSERT INTO admin_sessions(token_hash, admin_id, expires_at, created_at)
    VALUES ('legacy-token-hash', 'admin-legacy',
            '2099-01-01T00:00:00Z', '2026-08-01T00:00:00Z');
    INSERT INTO agent_model_config(
      id, provider, model_name, timeout_seconds, max_output_tokens,
      knowledge_retrieval_enabled, retrieval_count, explanation_enabled,
      api_key, updated_by, updated_at, last_test_status, last_test_at
    ) VALUES (1, 'openai-compatible', 'gpt-4o-mini', 30, 1024, 0, 3, 1,
              'sk-legacy-plaintext-key', 'admin-1',
              '2026-08-01T00:00:00Z', NULL, NULL);
  `);
  connection.close();
}

test("旧库 0013：明文 api_key 加密回填，库内不存明文，读取可解密", () => {
  const directory = mkdtempSync(join(tmpdir(), "kangmin-upgrade-apikey-"));
  const databasePath = join(directory, "legacy.sqlite");
  createLegacyModelConfigDatabase(databasePath);

  const KEY = Buffer.alloc(32, 7).toString("base64");
  const encryption = new AesGcmEncryption(parseEncryptionKeys(`v1:${KEY}`));
  const database = new KangminDatabase(databasePath, encryption);
  try {
    const row = database.connection
      .prepare(`
        SELECT api_key, encryption_key_version FROM agent_model_config WHERE id = 1
      `)
      .get() as unknown as { api_key: string; encryption_key_version: string };
    assert.equal(row.encryption_key_version, "v1");
    assert.ok(
      !row.api_key.includes("sk-legacy-plaintext-key"),
      "库内不得残留明文 api_key"
    );
    assert.equal(
      decryptStoredField(encryption, row.api_key, row.encryption_key_version, "模型 API Key"),
      "sk-legacy-plaintext-key"
    );
    assert.ok(appliedMigrationVersions(database).includes("0013_agent_model_api_key_encryption"));
  } finally {
    database.close();
  }
});

test("0012 孤儿会话升级抛明确错误，而不是晦涩的 FK 违约回滚", () => {
  // 模拟修复前的坏状态：账本已记录 0010 应用，但回填被 INSERT OR IGNORE
  // 吞掉（NULL development_subject），admin_sessions 引用未回填的 admin；
  // 0012 复制前必须检测孤儿行并给出可操作的错误信息。
  const directory = mkdtempSync(join(tmpdir(), "kangmin-upgrade-orphan-"));
  const databasePath = join(directory, "legacy.sqlite");
  createLegacyNullSubjectDatabase(databasePath);
  const connection = new DatabaseSync(databasePath);
  connection.exec(`
    INSERT INTO schema_migrations(version, applied_at) VALUES
      ('0010_admin_sessions_upgrade', '2026-08-01T00:00:00Z'),
      ('0011_admin_idempotency_fk', '2026-08-01T00:00:00Z');
  `);
  connection.close();

  assert.throws(
    () => new KangminDatabase(databasePath),
    (error: unknown) => {
      assert.ok(error instanceof DomainError, "应抛 DomainError");
      assert.equal(error.code, "config_missing");
      assert.match(error.message, /孤儿会话/u);
      assert.match(error.message, /0010/u);
      return true;
    }
  );
});

test("0014 媒体公开引用迁移：裸键存量改写为 /v1/media/<id>，无引用行不触碰", () => {
  const directory = mkdtempSync(join(tmpdir(), "kangmin-upgrade-media-"));
  const databasePath = join(directory, "media.sqlite");

  // 模拟 0014 前的旧数据：cover_url/media_url 落对象键裸键（stored_path）。
  const seed = new KangminDatabase(databasePath);
  seed.connection.exec(`
    INSERT INTO content_resource_media(
      id, kind, filename, stored_path, size_bytes, status,
      created_at, updated_at
    ) VALUES
      ('med_oldcover', 'image', 'cover.png', 'med_oldcover/cover.png', 10,
       'ready', '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z'),
      ('med_oldvideo', 'video', 'video.mp4', 'med_oldvideo/video.mp4', 20,
       'ready', '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z');
    INSERT INTO content_items(
      id, kind, title, category, summary, source, cover_url, media_url,
      status, patient_visible, version_valid, media_available,
      published_at, updated_at, cover_media_id, media_id
    ) VALUES
      ('legacy-item', 'video', '旧内容', '鼻炎科普', '摘要', '编辑部',
       'med_oldcover/cover.png', 'med_oldvideo/video.mp4',
       'published', 1, 1, 1,
       '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z',
       'med_oldcover', 'med_oldvideo'),
      ('legacy-free', 'article', '自由文本', '鼻炎科普', '摘要', '编辑部',
       'https://example.invalid/x.jpg', NULL,
       'published', 1, 1, 1,
       '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z', NULL, NULL);
    DELETE FROM schema_migrations
    WHERE version = '0014_content_media_public_urls';
  `);
  seed.close();

  // 回退账本后重开：0014 重放，裸键改写为公开媒体路由。
  const database = new KangminDatabase(databasePath);
  try {
    const rowOf = (id: string) =>
      database.connection
        .prepare("SELECT cover_url, media_url FROM content_items WHERE id = ?")
        .get(id) as unknown as {
        cover_url: string | null;
        media_url: string | null;
      };
    // 有素材引用的行：裸键改写为 /v1/media/<med_id>。
    const rewritten = rowOf("legacy-item");
    assert.equal(rewritten.cover_url, "/v1/media/med_oldcover");
    assert.equal(rewritten.media_url, "/v1/media/med_oldvideo");
    // 无素材引用的行（自由文本/外链 URL）：不触碰。
    const untouched = rowOf("legacy-free");
    assert.equal(untouched.cover_url, "https://example.invalid/x.jpg");
    assert.equal(untouched.media_url, null);
    assert.ok(
      appliedMigrationVersions(database).includes(
        "0014_content_media_public_urls"
      )
    );
  } finally {
    database.close();
  }
});
