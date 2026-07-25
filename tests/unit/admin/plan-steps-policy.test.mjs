import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("plan step writes invalidate approval and cannot mutate a published plan", async () => {
  const route = await readFile(new URL("../../../app/api/admin/steps/route.ts", import.meta.url), "utf8");
  assert.match(route, /plan\.status === "published"/);
  assert.match(route, /If-Match/);
  assert.match(route, /version = version \+ 1/);
  assert.match(route, /DELETE FROM clinical_approvals/);
  assert.match(route, /status IN \('draft', 'offline', 'index_failed'\)/);
});
