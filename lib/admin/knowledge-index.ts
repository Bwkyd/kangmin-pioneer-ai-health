import type { RuntimeEnv } from "./store.ts";
import { requiresClinicalApproval } from "./validation.ts";

export type KnowledgeSource = {
  id: string;
  title: string;
  type?: "article" | "video" | "knowledge" | "plan";
  category?: string;
  summary?: string;
  source: string;
  body: string;
  version: number;
};

export type KnowledgeCitation = {
  citationId: string;
  sourceId: string;
  sourceVersion: number;
  title: string;
  source: string;
  text: string;
};

type SearchRow = {
  id: string;
  knowledge_id: string;
  source_version: number;
  chunk_text: string;
  title: string;
  source: string;
  body?: string;
  metadata?: string;
  clinicalApprovalId?: string;
};

export function textChunks(text: string, size = 900) {
  const normalized = text.trim();
  const chunks: string[] = [];
  for (let offset = 0; offset < normalized.length; offset += size) {
    chunks.push(normalized.slice(offset, offset + size));
  }
  return chunks;
}

async function embed(gateway: Fetcher, texts: string[]) {
  const response = await gateway.fetch("https://internal/embed", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ texts }),
  });
  if (!response.ok) throw new Error("EMBEDDINGS_UNAVAILABLE");
  const payload = await response.json() as { vectors?: number[][] };
  if (!payload.vectors || payload.vectors.length !== texts.length) throw new Error("EMBEDDINGS_INVALID_RESPONSE");
  return payload.vectors;
}

export async function writeOptionalVectorIndex(
  values: RuntimeEnv,
  source: KnowledgeSource,
  chunks: string[],
  previousChunks: number,
  writeToken?: string,
  assertLease?: () => Promise<void>,
) {
  if (!values.VECTORIZE || !values.EMBEDDINGS) return "d1" as const;
  const vectors = await embed(values.EMBEDDINGS, chunks);
  await assertLease?.();
  if (previousChunks > 0 && !writeToken) {
    await values.VECTORIZE.deleteByIds(Array.from({ length: previousChunks }, (_, index) => `${source.id}:${index}`));
  }
  await assertLease?.();
  await values.VECTORIZE.upsert(vectors.map((vector, index) => ({
    id: writeToken ? `${source.id}:${source.version}:${writeToken}:${index}` : `${source.id}:${index}`,
    values: vector,
    metadata: { sourceId: source.id, sourceVersion: source.version, chunk: index, chunkId: `${source.id}:${index}` },
  })));
  return "d1+vector" as const;
}

function citation(row: SearchRow): KnowledgeCitation {
  return {
    citationId: row.id,
    sourceId: row.knowledge_id,
    sourceVersion: row.source_version,
    title: row.title,
    source: row.source,
    text: row.chunk_text,
  };
}

async function publishedChunk(values: RuntimeEnv & { DB: D1Database }, id: string) {
  const row = await values.DB.prepare("SELECT k.id, k.knowledge_id, k.source_version, k.chunk_text, c.type, c.title, c.category, c.summary, c.source, c.body, c.metadata, a.content_id clinicalApprovalId FROM knowledge_chunks k JOIN content_items c ON c.id = k.knowledge_id LEFT JOIN clinical_approvals a ON a.content_id = c.id AND a.content_version = c.version WHERE k.id = ? AND c.type = 'knowledge' AND c.status = 'published' AND c.version = k.source_version")
    .bind(id).first<SearchRow>();
  return row && (!requiresClinicalApproval("knowledge", row) || row.clinicalApprovalId) ? row : null;
}

async function vectorSearch(values: RuntimeEnv & { DB: D1Database }, query: string, limit: number) {
  if (!values.VECTORIZE || !values.EMBEDDINGS) return null;
  try {
    const [vector] = await embed(values.EMBEDDINGS, [query]);
    const result = await values.VECTORIZE.query(vector, { topK: limit, returnMetadata: "all" });
    const rows = await Promise.all(result.matches.map((match) => {
      const metadata = match.metadata as Record<string, unknown> | undefined;
      const chunkId = typeof metadata?.chunkId === "string" ? metadata.chunkId : match.id;
      return publishedChunk(values, chunkId);
    }));
    return rows.filter((row): row is SearchRow => Boolean(row)).map(citation);
  } catch {
    return null;
  }
}

export async function searchPublishedKnowledge(values: RuntimeEnv & { DB: D1Database }, query: string, limit: number) {
  const vectorMatches = await vectorSearch(values, query, limit);
  if (vectorMatches?.length) return { mode: "vector" as const, items: vectorMatches };
  const rows = await values.DB.prepare("SELECT k.id, k.knowledge_id, k.source_version, k.chunk_text, c.type, c.title, c.category, c.summary, c.source, c.body, c.metadata, a.content_id clinicalApprovalId FROM knowledge_chunks k JOIN content_items c ON c.id = k.knowledge_id LEFT JOIN clinical_approvals a ON a.content_id = c.id AND a.content_version = c.version WHERE c.type = 'knowledge' AND c.status = 'published' AND c.version = k.source_version AND instr(lower(k.chunk_text), lower(?)) > 0 ORDER BY c.published_at DESC, k.position ASC LIMIT ?")
    .bind(query, limit).all<SearchRow>();
  return { mode: "d1" as const, items: rows.results.filter((row) => !requiresClinicalApproval("knowledge", row) || row.clinicalApprovalId).map(citation) };
}
