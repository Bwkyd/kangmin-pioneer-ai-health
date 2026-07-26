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
});

test("发布不能绕过方案步骤，已发布内容不能被旧版本直接更新", async () => {
  const route = await readFile(new URL("../../../app/api/admin/content/route.ts", import.meta.url), "utf8");
  assert.match(route, /至少需要一个有效步骤/);
  assert.match(route, /item\.status === "published"/);
  assert.match(route, /已发布内容不能直接修改/);
});
