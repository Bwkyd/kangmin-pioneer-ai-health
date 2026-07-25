import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("正式智能体入口只提交三态评估和康复安全筛查，不提交客户端身份", async () => {
  const page = await readFile(new URL("../../../app/page.tsx", import.meta.url), "utf8");
  assert.match(page, /\/api\/v1\/agent\/explain/u);
  assert.match(page, /credentials: "same-origin"/u);
  assert.match(page, /rehabSafety: \{ method: rehabMethod, answers: rehabSafety \}/u);
  assert.match(page, /不确定不会被当成没有/u);
  assert.doesNotMatch(page, /["']x-user-id["']/iu);
});

test("用药历史读取失败时显示重试入口，而不是伪装成空记录", async () => {
  const page = await readFile(new URL("../../../app/page.tsx", import.meta.url), "utf8");
  assert.match(page, /用药历史暂时无法读取/u);
  assert.match(page, /读取失败，不能判断当前是否没有用药记录/u);
  assert.match(page, /onClick=\{openHealthProfile\}/u);
});
