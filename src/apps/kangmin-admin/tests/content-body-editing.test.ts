import assert from "node:assert/strict";
import test from "node:test";
import { appendBodyAttachment } from "../src/content-body-editing.js";

test("正文附件上传完成时合并用户在等待期间追加的最新正文", () => {
  assert.equal(appendBodyAttachment("用户在上传期间编辑的正文", "[附件](/v1/media/med-1)"), "用户在上传期间编辑的正文\n\n[附件](/v1/media/med-1)");
  assert.equal(appendBodyAttachment("  ", "![图片](/v1/media/med-2)"), "![图片](/v1/media/med-2)");
});
