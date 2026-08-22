import { DomainError } from "../../kernel/errors.js";
import {
  encodeNormalizedEmbedding,
  normalizedEmbeddingDimensions,
  normalizedEmbeddingScore,
  type KnowledgeEmbeddingPort
} from "../../modules/agent/knowledge-ports.js";
import type { KnowledgeRetrievalPort, KnowledgeSource } from "../../modules/agent/knowledge-ports.js";
import { KangminPgDatabase } from "./pg-database.js";

interface SemanticRow {
  knowledge_id: string;
  name: string;
  category: string | null;
  source: string | null;
  chunk_index: number;
  chunk_text: string;
  dimensions: number | null;
  embedding: Buffer | null;
}

export class PgKnowledgeRetrieval implements KnowledgeRetrievalPort {
  constructor(
    private readonly database: KangminPgDatabase,
    private readonly embeddings: KnowledgeEmbeddingPort
  ) {}
  async searchEnabled(query: string, limit: number): Promise<KnowledgeSource[]> {
    const { rows } = await this.database.query<SemanticRow>(`
      SELECT items.id AS knowledge_id, items.name, items.category, items.source,
             chunks.chunk_index, chunks.chunk_text,
             vectors.dimensions, vectors.embedding
      FROM agent_knowledge_chunks AS chunks
      JOIN agent_knowledge_items AS items ON items.id = chunks.knowledge_id
      LEFT JOIN agent_knowledge_embeddings AS vectors
        ON vectors.knowledge_id = chunks.knowledge_id
       AND vectors.chunk_index = chunks.chunk_index
       AND vectors.model_name = $1
      WHERE items.status = 'enabled'
      ORDER BY items.id ASC, chunks.chunk_index ASC
    `, [this.embeddings.modelName]);
    if (rows.length === 0) return [];
    if (rows.some((row) => row.embedding === null || row.dimensions === null)) {
      throw new DomainError(
        "capability_unavailable",
        "已启用知识的语义索引尚未完成，请先重新建立索引"
      );
    }
    const [queryVector] = await this.embeddings.embed([query]);
    if (queryVector === undefined) {
      throw new DomainError("provider_unavailable", "知识向量服务没有返回查询向量");
    }
    const queryBytes = encodeNormalizedEmbedding(queryVector);
    const dimensions = normalizedEmbeddingDimensions(queryBytes);
    const scored = rows.map((row): KnowledgeSource => {
      if (row.embedding === null || row.dimensions === null || row.dimensions !== dimensions) {
        throw new DomainError("capability_unavailable", "已启用知识的语义索引维度不一致");
      }
      return {
        knowledgeId: row.knowledge_id,
        name: row.name,
        category: row.category,
        source: row.source,
        chunkIndex: row.chunk_index,
        text: row.chunk_text,
        score: normalizedEmbeddingScore(queryBytes, row.embedding)
      };
    });
    return scored
      .sort((left, right) =>
        right.score - left.score ||
        left.knowledgeId.localeCompare(right.knowledgeId) ||
        left.chunkIndex - right.chunkIndex
      )
      .slice(0, Math.max(0, limit));
  }
}
