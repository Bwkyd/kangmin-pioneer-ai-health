import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("admin reuses the mini-program blue brand palette", async () => {
  const stylesheet = await readFile(new URL("../../../app/admin/admin.css", import.meta.url), "utf8");

  assert.match(stylesheet, /--admin-blue:#1e5aa3/);
  assert.match(stylesheet, /--admin-blue-dark:#123b73/);
  assert.doesNotMatch(stylesheet, /--admin-green/);
  assert.doesNotMatch(stylesheet, /#123e35|#2aa789|#35a88e|#8ee0c9|#126e5d|#259a7e/);
});
