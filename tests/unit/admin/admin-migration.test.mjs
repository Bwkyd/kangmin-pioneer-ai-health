import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

test("admin migration contains durable content, media, notification and audit tables", async () => {
  const directory = new URL("../../../drizzle/", import.meta.url);
  const migrations = (await readdir(directory)).filter((name) => name.endsWith(".sql")).sort();
  const sql = (await Promise.all(migrations.map((name) => readFile(new URL(name, directory), "utf8")))).join("\n");
  for (const table of ["content_items", "media_assets", "clinical_approvals", "plan_steps", "knowledge_chunks", "notifications", "notification_reads", "audit_logs", "idempotency_keys"]) {
    assert.match(sql, new RegExp("CREATE TABLE `" + table + "`"));
  }
  assert.match(sql, /ON DELETE cascade/);
  assert.match(sql, /CREATE UNIQUE INDEX/);
});

test("临床候选字段和管理幂等键联合主键迁移均已登记为最新快照", async () => {
  const directory = new URL("../../../drizzle/", import.meta.url);
  const journal = JSON.parse(await readFile(new URL("meta/_journal.json", directory), "utf8"));
  assert.equal(journal.entries.at(-1).tag, "0010_moaning_the_enforcers");
  const migration = await readFile(new URL("0008_safe_brood.sql", directory), "utf8");
  const previousMigration = await readFile(new URL("0009_gigantic_roulette.sql", directory), "utf8");
  const latestMigration = await readFile(new URL("0010_moaning_the_enforcers.sql", directory), "utf8");
  const snapshot = JSON.parse(await readFile(new URL("meta/0010_snapshot.json", directory), "utf8"));
  assert.match(migration, /ADD `write_token` text/u);
  assert.match(previousMigration, /PRIMARY KEY\(`key`, `actor`\)/u);
  assert.match(latestMigration, /clinical_review_status/);
  assert.match(latestMigration, /clinical_approvals/);
  assert.equal(snapshot.prevId, JSON.parse(await readFile(new URL("meta/0009_snapshot.json", directory), "utf8")).id);
  assert.equal(snapshot.tables.content_items.columns.write_token.name, "write_token");
  assert.equal(snapshot.tables.content_items.columns.clinical_candidate_kind.name, "clinical_candidate_kind");
  assert.equal(snapshot.tables.content_items.columns.clinical_review_status.default, "'pending_review'");
  assert.deepEqual(snapshot.tables.idempotency_keys.compositePrimaryKeys.idempotency_keys_key_actor_pk.columns, ["key", "actor"]);
});
