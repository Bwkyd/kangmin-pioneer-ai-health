import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("内容版本变更使用一次性写入令牌，防止旧步骤请求插入新版本", async () => {
  const route = await readFile(new URL("../../../app/api/admin/content/route.ts", import.meta.url), "utf8");
  const dependencies = await readFile(new URL("../../../lib/admin/content-dependencies.ts", import.meta.url), "utf8");
  const steps = await readFile(new URL("../../../app/api/admin/steps/route.ts", import.meta.url), "utf8");
  assert.match(route, /write_token = \?/);
  assert.match(route, /status IN \('draft', 'offline', 'index_failed'\)/);
  assert.match(dependencies, /video\.media_id = step\.media_id/);
  assert.match(dependencies, /approval\.content_version = video\.version/);
  assert.match(dependencies, /video\.status = 'published'/);
  assert.match(dependencies, /调理步骤只能关联已发布且通过当前临床审核的视频/);
  assert.match(route, /GROUP_CONCAT/);
  assert.match(steps, /write_token = \?/);
  assert.match(steps, /AND write_token = \?/);
});

test("知识索引使用可回收租约，旧请求不能继续覆盖新索引", async () => {
  const route = await readFile(new URL("../../../app/api/admin/knowledge/retry/route.ts", import.meta.url), "utf8");
  assert.match(route, /INDEX_LEASE_MS/);
  assert.match(route, /status = 'indexing' AND updated_at < \?/);
  assert.match(route, /status = 'indexing' AND write_token = \?/);
  assert.match(route, /仍在索引处理中/);
  assert.match(route, /status = 'indexing' AND write_token = \?/);
  assert.match(route, /EXISTS \(SELECT 1 FROM content_items/);
});
