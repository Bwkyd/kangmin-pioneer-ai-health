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
