import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("health records migration defines ownership, grouped exposures, cascade and idempotency", async () => {
  const sql = (await Promise.all(["0003_magenta_proteus.sql", "0004_rare_luckman.sql", "0005_lean_pixie.sql"].map((name) => readFile(new URL(`../../../drizzle/${name}`, import.meta.url), "utf8")))).join("\n");
  for (const table of ["health_profiles", "medication_records", "symptom_records", "allergen_exposure_records", "allergen_exposure_selections", "health_record_idempotency"]) assert.match(sql, new RegExp("CREATE TABLE `" + table + "`"));
  assert.match(sql, /`user_id` text NOT NULL/u);
  assert.match(sql, /ON DELETE cascade/u);
  assert.match(sql, /health_record_idempotency_user_scope_key_idx/u);
  assert.match(sql, /`common_triggers` text DEFAULT '\[\]' NOT NULL/u);
  assert.doesNotMatch(sql, /pollen_monitor|diagnosis|effectiveness|recommendation/iu);
});

test("latest health migration makes one patient-reported exposure record per day", async () => {
  const sql = await readFile(new URL("../../../drizzle/0007_handy_mephisto.sql", import.meta.url), "utf8");
  assert.match(sql, /DELETE FROM `allergen_exposure_selections`/u);
  assert.match(sql, /DELETE FROM `allergen_exposure_records`/u);
  assert.match(sql, /CREATE UNIQUE INDEX `allergen_exposure_records_user_date_idx` ON `allergen_exposure_records` \(`user_id`,`exposure_date`\)/u);
});
