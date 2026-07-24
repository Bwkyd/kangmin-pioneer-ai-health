import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("admin migration contains durable content, media, notification and audit tables", async () => {
  const sql = await readFile(new URL("../../../drizzle/0000_sturdy_gideon.sql", import.meta.url), "utf8");
  for (const table of ["content_items", "media_assets", "plan_steps", "notifications", "notification_reads", "audit_logs", "idempotency_keys"]) {
    assert.match(sql, new RegExp("CREATE TABLE `" + table + "`"));
  }
  assert.match(sql, /ON DELETE cascade/);
  assert.match(sql, /CREATE UNIQUE INDEX/);
});
