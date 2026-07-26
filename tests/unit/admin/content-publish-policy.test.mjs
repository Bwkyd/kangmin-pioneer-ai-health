import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { adminSchemaStatements } from "../../../lib/admin/schema-sql.ts";
import { invalidPlanStepMediaSql } from "../../../lib/admin/content-dependencies.ts";

const SQLITE_AVAILABLE = spawnSync("sqlite3", ["--version"], { stdio: "ignore" }).status === 0;

function runSqlite(database, sql) {
  return new Promise((resolve, reject) => {
    const child = spawn("sqlite3", [database], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve(stdout.trim()) : reject(new Error(stderr || `sqlite3 exited with ${code}`)));
    child.stdin.end(sql);
  });
}

test("真实 SQLite 行为：调理方案不能发布缺失或未审核的视频依赖", { skip: !SQLITE_AVAILABLE }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "kangmin-content-policy-"));
  const database = path.join(directory, "content.sqlite");
  try {
    await runSqlite(database, `${adminSchemaStatements.join(";\n")};\nPRAGMA foreign_keys = ON;\nINSERT INTO media_assets (id, kind, filename, object_key, content_type, byte_size, status, created_at, updated_at) VALUES ('media-1', 'video', 'demo.mp4', 'demo.mp4', 'video/mp4', 1, 'ready', '2026-07-26T00:00:00Z', '2026-07-26T00:00:00Z');\nINSERT INTO content_items (id, type, title, status, version, metadata, created_at, updated_at) VALUES ('plan-1', 'plan', '方案', 'draft', 1, '{}', '2026-07-26T00:00:00Z', '2026-07-26T00:00:00Z');\nINSERT INTO plan_steps (id, plan_id, position, title, instruction, media_id, created_at, updated_at) VALUES ('step-1', 'plan-1', 1, '步骤', '说明', 'media-1', '2026-07-26T00:00:00Z', '2026-07-26T00:00:00Z');`);

    const dependencyQuery = `SELECT COUNT(*) FROM plan_steps step WHERE step.plan_id = 'plan-1' AND ${invalidPlanStepMediaSql};`;
    assert.equal(await runSqlite(database, dependencyQuery), "1");

    await runSqlite(database, "INSERT INTO content_items (id, type, title, media_id, status, version, metadata, created_at, updated_at) VALUES ('video-1', 'video', '视频', 'media-1', 'draft', 1, '{}', '2026-07-26T00:00:00Z', '2026-07-26T00:00:00Z'); INSERT INTO clinical_approvals (content_id, content_version, approver, approved_at) VALUES ('video-1', 1, 'clinician', '2026-07-26T00:00:00Z');");
    assert.equal(await runSqlite(database, dependencyQuery), "1");

    await runSqlite(database, "UPDATE content_items SET status = 'published', published_at = '2026-07-26T00:00:01Z' WHERE id = 'video-1';");
    assert.equal(await runSqlite(database, dependencyQuery), "0");

    await runSqlite(database, "UPDATE content_items SET status = 'offline' WHERE id = 'video-1';");
    assert.equal(await runSqlite(database, dependencyQuery), "1");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
