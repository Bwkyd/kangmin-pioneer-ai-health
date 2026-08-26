import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { appliedMigrationVersions, KangminDatabase } from "../infrastructure/database.js";

test("旧分类迁移为一级目录且不改知识状态与分块计数", () => {
  const current = new KangminDatabase(":memory:");
  const previousVersions = appliedMigrationVersions(current).filter(
    (version) => version !== "0021_knowledge_folders"
  );
  current.close();

  const path = join(mkdtempSync(join(tmpdir(), "kangmin-folder-migration-")), "legacy.sqlite");
  const legacy = new DatabaseSync(path);
  legacy.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE agent_knowledge_items (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      category TEXT,
      source TEXT,
      description TEXT,
      source_media_id TEXT,
      size_bytes INTEGER NOT NULL,
      mime_type TEXT,
      sha256 TEXT,
      status TEXT NOT NULL,
      parse_error TEXT,
      chunk_count INTEGER NOT NULL,
      created_by TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;
  `);
  const migration = legacy.prepare(
    "INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)"
  );
  for (const version of previousVersions) {
    migration.run(version, "2026-08-25T00:00:00.000Z");
  }
  const insert = legacy.prepare(`
    INSERT INTO agent_knowledge_items(
      id, name, category, source, description, source_media_id, size_bytes,
      mime_type, sha256, status, parse_error, chunk_count, created_by,
      created_at, updated_at
    ) VALUES (?, ?, ?, NULL, NULL, NULL, 1, 'text/markdown', NULL, ?, NULL, ?, NULL, ?, ?)
  `);
  insert.run("k1", "基础一", "鼻炎基础", "enabled", 3, "2026-08-20T00:00:00.000Z", "2026-08-21T00:00:00.000Z");
  insert.run("k2", "基础二", "鼻炎基础", "disabled", 2, "2026-08-20T00:00:00.000Z", "2026-08-22T00:00:00.000Z");
  insert.run("k3", "未分类", null, "indexed", 1, "2026-08-20T00:00:00.000Z", "2026-08-23T00:00:00.000Z");
  legacy.close();

  const upgraded = new KangminDatabase(path);
  try {
    const folders = upgraded.connection.prepare(`
      SELECT id, name, parent_id FROM agent_knowledge_folders ORDER BY name
    `).all() as unknown as Array<{ id: string; name: string; parent_id: string | null }>;
    assert.equal(folders.length, 1);
    assert.equal(folders[0]?.name, "鼻炎基础");
    assert.equal(folders[0]?.parent_id, null);
    const rows = upgraded.connection.prepare(`
      SELECT id, folder_id, status, chunk_count
      FROM agent_knowledge_items ORDER BY id
    `).all() as unknown as Array<{ id: string; folder_id: string | null; status: string; chunk_count: number }>;
    assert.equal(rows[0]?.folder_id, folders[0]?.id);
    assert.equal(rows[1]?.folder_id, folders[0]?.id);
    assert.equal(rows[2]?.folder_id, null);
    assert.deepEqual(rows.map(({ status, chunk_count }) => [status, chunk_count]), [
      ["enabled", 3],
      ["disabled", 2],
      ["indexed", 1]
    ]);
  } finally {
    upgraded.close();
  }
});
