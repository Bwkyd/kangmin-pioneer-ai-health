import assert from "node:assert/strict";
import test from "node:test";
import { searchPublishedKnowledge, textChunks, writeOptionalVectorIndex } from "../../../lib/admin/knowledge-index.ts";

test("knowledge text is normalized and split deterministically", () => {
  assert.deepEqual(textChunks("  abcdef  ", 3), ["abc", "def"]);
  assert.deepEqual(textChunks("   "), []);
});

test("D1 remains a complete index when vector bindings are absent", async () => {
  const mode = await writeOptionalVectorIndex({}, { id: "knowledge_1", title: "标题", source: "来源", body: "正文", version: 3 }, ["正文"], 0);
  assert.equal(mode, "d1");
});

test("索引租约清理旧向量代际，并保留当前写入令牌", async () => {
  const calls = [];
  const mode = await writeOptionalVectorIndex({
    EMBEDDINGS: { fetch: async () => Response.json({ vectors: [[0.1, 0.2]] }) },
    VECTORIZE: {
      deleteByIds: async (ids) => calls.push({ type: "delete", ids }),
      upsert: async (vectors) => calls.push({ type: "upsert", vectors }),
    },
  }, { id: "knowledge_1", title: "标题", source: "来源", body: "正文", version: 3 }, ["正文"], 2, "new-generation", async () => {}, [{ version: 3, writeTokens: ["old-generation"] }]);
  assert.equal(mode, "d1+vector");
  assert.deepEqual(calls.find((call) => call.type === "delete").ids, ["knowledge_1:3:old-generation:0", "knowledge_1:3:old-generation:1"]);
  assert.match(calls.find((call) => call.type === "upsert").vectors[0].id, /new-generation/u);
  assert.equal(calls.find((call) => call.type === "upsert").vectors[0].metadata.chunkId, "knowledge_1:3:0");
  assert.equal(calls.find((call) => call.type === "upsert").vectors[0].metadata.writeToken, "new-generation");
});

test("旧代际在写入后失去租约时会被补偿删除", async () => {
  const calls = [];
  let leaseChecks = 0;
  await assert.rejects(
    writeOptionalVectorIndex({
      EMBEDDINGS: { fetch: async () => Response.json({ vectors: [[0.1, 0.2]] }) },
      VECTORIZE: {
        deleteByIds: async (ids) => calls.push({ type: "delete", ids }),
        upsert: async (vectors) => calls.push({ type: "upsert", vectors }),
      },
    }, { id: "knowledge_1", title: "标题", source: "来源", body: "正文", version: 3 }, ["正文"], 0, "new-generation", async () => {
      leaseChecks += 1;
      if (leaseChecks === 3) throw new Error("KNOWLEDGE_INDEX_LEASE_LOST");
    }),
    /KNOWLEDGE_INDEX_LEASE_LOST/u,
  );
  assert.equal(calls.filter((call) => call.type === "upsert").length, 1);
  assert.deepEqual(calls.filter((call) => call.type === "delete")[0].ids, ["knowledge_1:3:new-generation:0"]);
});

test("向量检索在清理旧代际前也会去重并补足 topK", async () => {
  let queryOptions;
  const row = {
    id: "knowledge_1:3:0",
    knowledge_id: "knowledge_1",
    source_version: 3,
    chunk_text: "正文",
    type: "knowledge",
    title: "标题",
    category: "分类",
    summary: "摘要",
    source: "来源",
    body: "正文",
    metadata: "{}",
    clinicalApprovalId: "knowledge_1",
  };
  const result = await searchPublishedKnowledge({
    EMBEDDINGS: { fetch: async () => Response.json({ vectors: [[0.1, 0.2]] }) },
    VECTORIZE: {
      query: async (_vector, options) => {
        queryOptions = options;
        return { matches: [
          { id: "old-generation", metadata: { chunkId: row.id } },
          { id: "new-generation", metadata: { chunkId: row.id } },
        ] };
      },
    },
    DB: {
      prepare: () => ({
        bind: () => ({ first: async () => row }),
      }),
    },
  }, "鼻炎", 5);
  assert.equal(queryOptions.topK, 40);
  assert.deepEqual(result.items, [{ citationId: row.id, sourceId: "knowledge_1", sourceVersion: 3, title: "标题", source: "来源", text: "正文" }]);
});
