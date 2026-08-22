import { resolve } from "node:path";

import { DashscopeEmbeddingAdapter } from "../infrastructure/dashscope-embedding-adapter.js";
import { KangminDatabase } from "../infrastructure/database.js";
import { PlaintextEncryption } from "../infrastructure/aes-gcm-encryption.js";
import { SqliteAgentAdminRepository } from "../infrastructure/sqlite-agent-admin-repository.js";
import { KangminPgDatabase } from "../infrastructure/postgres/pg-database.js";
import { PgAgentAdminRepository } from "../infrastructure/postgres/pg-agent-admin-repository.js";
import {
  embedKnowledgeTexts,
  type KnowledgeEmbeddingPort
} from "../modules/agent/knowledge-ports.js";
import type { AgentAdminRepository } from "../modules/agent-admin/agent-admin-ports.js";

export async function reindexExistingKnowledge(
  repository: AgentAdminRepository,
  embeddings: KnowledgeEmbeddingPort
): Promise<{ indexedItems: number; indexedChunks: number }> {
  const items = (await repository.listKnowledge()).filter(
    (item) => item.status !== "index_failed" && item.chunkCount > 0
  );
  let indexedChunks = 0;
  for (const item of items) {
    const chunks = await repository.listKnowledgeChunks(item.id);
    if (chunks.length !== item.chunkCount) {
      throw new Error("knowledge chunk count mismatch");
    }
    const encoded = await embedKnowledgeTexts(
      embeddings,
      chunks.map((chunk) => chunk.text)
    );
    const indexedAt = new Date().toISOString();
    const result = await repository.replaceKnowledgeEmbeddings(
      item.id,
      encoded.modelName,
      encoded.dimensions,
      chunks.map((chunk, index) => ({
        chunkIndex: chunk.index,
        embedding: encoded.vectors[index]!
      })),
      indexedAt
    );
    if (result !== "updated") throw new Error("knowledge disappeared during reindex");
    if (item.status === "processing") {
      const status = await repository.setKnowledgeStatus(item.id, "indexed", indexedAt);
      if (status !== "updated") throw new Error("knowledge disappeared after reindex");
    }
    indexedChunks += chunks.length;
  }
  return { indexedItems: items.length, indexedChunks };
}

async function main(): Promise<void> {
  const embeddings = new DashscopeEmbeddingAdapter({
    apiKey: process.env.KANGMIN_QWEN_API_KEY,
    model: process.env.KANGMIN_EMBEDDING_MODEL,
    baseUrl: process.env.KANGMIN_EMBEDDING_BASE_URL
  });
  const databaseUrl = process.env.KANGMIN_DATABASE_URL?.trim();
  if (databaseUrl) {
    const database = new KangminPgDatabase(databaseUrl);
    try {
      const result = await reindexExistingKnowledge(
        new PgAgentAdminRepository(database, new PlaintextEncryption()),
        embeddings
      );
      console.log(JSON.stringify(result));
    } finally {
      await database.close();
    }
    return;
  }
  const databasePath = resolve(
    process.env.KANGMIN_DB_PATH ?? ".local/kangmin-mvp.sqlite"
  );
  const database = new KangminDatabase(databasePath);
  try {
    const result = await reindexExistingKnowledge(
      new SqliteAgentAdminRepository(database, new PlaintextEncryption()),
      embeddings
    );
    console.log(JSON.stringify(result));
  } finally {
    database.close();
  }
}

if (process.argv[1]?.endsWith("reindex-knowledge.js")) {
  await main();
}
