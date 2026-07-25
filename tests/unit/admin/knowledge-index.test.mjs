import assert from "node:assert/strict";
import test from "node:test";
import { textChunks, writeOptionalVectorIndex } from "../../../lib/admin/knowledge-index.ts";

test("knowledge text is normalized and split deterministically", () => {
  assert.deepEqual(textChunks("  abcdef  ", 3), ["abc", "def"]);
  assert.deepEqual(textChunks("   "), []);
});

test("D1 remains a complete index when vector bindings are absent", async () => {
  const mode = await writeOptionalVectorIndex({}, { id: "knowledge_1", title: "标题", source: "来源", body: "正文", version: 3 }, ["正文"], 0);
  assert.equal(mode, "d1");
});
