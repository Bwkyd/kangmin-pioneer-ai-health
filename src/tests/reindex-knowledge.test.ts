import assert from "node:assert/strict";
import test from "node:test";

import { PlaintextEncryption } from "../infrastructure/aes-gcm-encryption.js";
import { KangminDatabase } from "../infrastructure/database.js";
import { SqliteAgentAdminRepository } from "../infrastructure/sqlite-agent-admin-repository.js";
import { reindexExistingKnowledge } from "../scripts/reindex-knowledge.js";
import type { KnowledgeRow } from "@kangmin/core/operations/agent-admin/agent-admin-ports";
import { TestKnowledgeEmbedding } from "./test-knowledge-embedding.js";

function item(id: string, status: KnowledgeRow["status"]): KnowledgeRow & {
  chunks: Array<{ index: number; text: string }>;
} {
  const chunks = [{ index: 0, text: `${id} 鼻部科普内容` }];
  return {
    id,
    name: id,
    folderId: null,
    category: "测试",
    source: "测试来源",
    description: null,
    sourceMediaId: null,
    sizeBytes: 1,
    mimeType: "text/markdown",
    sha256: null,
    status,
    parseError: null,
    chunkCount: chunks.length,
    createdBy: null,
    createdAt: "2026-08-22T00:00:00.000Z",
    updatedAt: "2026-08-22T00:00:00.000Z",
    chunks
  };
}

test("旧数据回填：处理中/已索引/已启用/已停用同批建立语义索引", async () => {
  const database = new KangminDatabase(":memory:");
  const repository = new SqliteAgentAdminRepository(database, new PlaintextEncryption());
  try {
    for (const [id, status] of [
      ["processing", "processing"],
      ["indexed", "indexed"],
      ["enabled", "enabled"],
      ["disabled", "disabled"]
    ] as const) {
      await repository.createKnowledge(item(id, status));
    }
    await repository.createKnowledge(item("failed", "index_failed"));

    const result = await reindexExistingKnowledge(repository, new TestKnowledgeEmbedding());
    assert.deepEqual(result, { indexedItems: 4, indexedChunks: 4 });
    assert.equal((await repository.findKnowledge("processing"))?.status, "indexed");
    assert.equal((await repository.findKnowledge("enabled"))?.status, "enabled");
    const vectors = database.connection.prepare(`
      SELECT knowledge_id, model_name, dimensions
      FROM agent_knowledge_embeddings
      ORDER BY knowledge_id
    `).all() as unknown as Array<{ knowledge_id: string; model_name: string; dimensions: number }>;
    assert.deepEqual(vectors.map((row) => row.knowledge_id), [
      "disabled", "enabled", "indexed", "processing"
    ]);
    assert.ok(vectors.every((row) => row.model_name === "test-knowledge-embedding-v1"));
    assert.ok(vectors.every((row) => row.dimensions === 64));
  } finally {
    database.close();
  }
});
