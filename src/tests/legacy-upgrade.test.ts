import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { KangminDatabase } from "../infrastructure/database.js";

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
