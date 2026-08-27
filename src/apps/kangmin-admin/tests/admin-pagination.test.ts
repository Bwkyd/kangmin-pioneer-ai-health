import assert from "node:assert/strict";
import test from "node:test";
import { clampPage, itemsForPage, pageCountFor } from "../src/admin-pagination.ts";

test("后台视频分页：0、1、20、21、40、41 条边界", () => {
  assert.equal(pageCountFor(0), 1);
  assert.equal(pageCountFor(1), 1);
  assert.equal(pageCountFor(20), 1);
  assert.equal(pageCountFor(21), 2);
  assert.equal(pageCountFor(40), 2);
  assert.equal(pageCountFor(41), 3);

  const items = Array.from({ length: 41 }, (_, index) => index + 1);
  assert.deepEqual(itemsForPage(items, 1), items.slice(0, 20));
  assert.deepEqual(itemsForPage(items, 2), items.slice(20, 40));
  assert.deepEqual(itemsForPage(items, 3), [41]);
});

test("后台视频分页：结果减少后回到最近有效页", () => {
  assert.equal(clampPage(3, 41), 3);
  assert.equal(clampPage(3, 40), 2);
  assert.equal(clampPage(2, 20), 1);
  assert.equal(clampPage(0, 21), 1);
});
