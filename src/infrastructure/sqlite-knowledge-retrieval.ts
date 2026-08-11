import type { KnowledgeRetrievalPort, KnowledgeSource } from "../modules/agent/knowledge-qa.js";
import { KangminDatabase } from "./database.js";

function terms(query: string): string[] {
  const compact = query.replace(/[，。！？、；：,.!?;:\s]+/gu, "");
  const grams = Array.from({ length: Math.max(0, compact.length - 1) }, (_, index) => compact.slice(index, index + 2));
  return [...new Set([query.trim(), ...grams].filter((value) => value.length >= 2))].slice(0, 8);
}

export class SqliteKnowledgeRetrieval implements KnowledgeRetrievalPort {
  constructor(private readonly database: KangminDatabase) {}
  async searchEnabled(query: string, limit: number): Promise<KnowledgeSource[]> {
    const values = terms(query);
    const where = values.map(() => "chunks.chunk_text LIKE '%' || ? || '%'").join(" OR ");
    const rows = this.database.connection.prepare(`
      SELECT items.id AS knowledge_id, items.name, items.source, chunks.chunk_index, chunks.chunk_text
      FROM agent_knowledge_chunks chunks
      JOIN agent_knowledge_items items ON items.id = chunks.knowledge_id
      WHERE items.status = 'enabled' AND (${where})
      ORDER BY items.updated_at DESC, chunks.chunk_index ASC LIMIT ?
    `).all(...values, limit) as unknown as Array<{ knowledge_id: string; name: string; source: string | null; chunk_index: number; chunk_text: string }>;
    return rows.map((row) => ({ knowledgeId: row.knowledge_id, name: row.name, source: row.source, chunkIndex: row.chunk_index, text: row.chunk_text }));
  }
}
