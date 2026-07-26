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

test("索引租约使用独立向量代际，旧 worker 不删除或覆盖新代际", async () => {
  const calls = [];
  const mode = await writeOptionalVectorIndex({
    EMBEDDINGS: { fetch: async () => Response.json({ vectors: [[0.1, 0.2]] }) },
    VECTORIZE: {
      deleteByIds: async (ids) => calls.push({ type: "delete", ids }),
      upsert: async (vectors) => calls.push({ type: "upsert", vectors }),
    },
  }, { id: "knowledge_1", title: "标题", source: "来源", body: "正文", version: 3 }, ["正文"], 2, "new-generation", async () => {});
  assert.equal(mode, "d1+vector");
  assert.equal(calls.some((call) => call.type === "delete"), false);
  assert.match(calls.find((call) => call.type === "upsert").vectors[0].id, /new-generation/u);
  assert.equal(calls.find((call) => call.type === "upsert").vectors[0].metadata.chunkId, "knowledge_1:0");
});
