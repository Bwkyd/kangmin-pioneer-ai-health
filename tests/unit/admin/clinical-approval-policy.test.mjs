import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("临床审核必须绑定当前版本，并拒绝空步骤方案", async () => {
  const route = await readFile(new URL("../../../app/api/admin/clinical-approvals/route.ts", import.meta.url), "utf8");
  assert.match(route, /If-Match/);
  assert.match(route, /version !== item\.version/);
  assert.match(route, /至少需要一个有效步骤/);
  assert.match(route, /version = \?/);
  assert.match(route, /status IN \('draft', 'offline', 'index_failed'\)/);
  assert.match(route, /clinical_review_status = 'approved'/);
  assert.match(route, /clinical_candidate_kind/);
  assert.match(route, /clinical_change_diff/);
});

test("发布不能绕过方案步骤，已发布内容不能被旧版本直接更新", async () => {
  const route = await readFile(new URL("../../../app/api/admin/content/route.ts", import.meta.url), "utf8");
  assert.match(route, /至少需要一个有效步骤/);
  assert.match(route, /item\.status === "published"/);
  assert.match(route, /已发布内容不能直接修改/);
  assert.match(route, /publish_blocked/);
  assert.match(route, /clinical_review_required/);
});

test("旧 D1 表在启动时补齐临床候选字段并回填当前版本审核", async () => {
  const store = await readFile(new URL("../../../lib/admin/store.ts", import.meta.url), "utf8");
  assert.match(store, /PRAGMA table_info\(content_items\)/u);
  assert.match(store, /ALTER TABLE content_items ADD COLUMN/u);
  assert.match(store, /clinical_approvals\.content_version = content_items\.version/u);
});
