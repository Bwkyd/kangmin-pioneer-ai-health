import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("内容版本变更使用一次性写入令牌，防止旧步骤请求插入新版本", async () => {
  const route = await readFile(new URL("../../../app/api/admin/content/route.ts", import.meta.url), "utf8");
  const steps = await readFile(new URL("../../../app/api/admin/steps/route.ts", import.meta.url), "utf8");
  assert.match(route, /write_token = \?/);
  assert.match(route, /status IN \('draft', 'offline', 'index_failed'\)/);
  assert.match(steps, /write_token = \?/);
  assert.match(steps, /AND write_token = \?/);
});
