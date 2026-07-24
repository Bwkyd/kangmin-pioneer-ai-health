import { requireAdmin } from "@/lib/admin/auth";
import { audit, jsonError, now, runtime } from "@/lib/admin/store";

function textChunks(text: string, size = 900) {
  const chunks: string[] = [];
  for (let offset = 0; offset < text.length; offset += size) chunks.push(text.slice(offset, offset + size));
  return chunks;
}

export async function POST(request: Request) {
  try {
    const session = await requireAdmin();
    const { id } = await request.json() as { id?: string };
    const values = await runtime();
    const item = await values.DB.prepare("SELECT id, title, body, media_id FROM content_items WHERE id = ? AND type = 'knowledge'").bind(id).first<{ id: string; title: string; body: string; media_id: string | null }>();
    if (!item) return jsonError("知识资料不存在", 404);
    await values.DB.prepare("UPDATE content_items SET status = 'indexing', updated_at = ? WHERE id = ?").bind(now(), id).run();
    try {
      if (!values.VECTORIZE) throw new Error("VECTORIZE_NOT_CONFIGURED");
      const chunks = textChunks(item.body || item.title);
      if (chunks.length === 0) throw new Error("KNOWLEDGE_TEXT_EMPTY");
      // Embeddings must be supplied by the configured indexing gateway. This route
      // never lets the language model alter clinical rules or publish state.
      const gateway = values as typeof values & { EMBEDDINGS?: Fetcher };
      if (!gateway.EMBEDDINGS) throw new Error("EMBEDDINGS_NOT_CONFIGURED");
      const response = await gateway.EMBEDDINGS.fetch("https://internal/embed", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ texts: chunks }) });
      if (!response.ok) throw new Error("EMBEDDINGS_UNAVAILABLE");
      const payload = await response.json() as { vectors: number[][] };
      await values.VECTORIZE.upsert(payload.vectors.map((vector, index) => ({ id: `${item.id}:${index}`, values: vector, metadata: { sourceId: item.id, chunk: index } })));
      await values.DB.prepare("UPDATE content_items SET status = 'draft', metadata = json_set(metadata, '$.indexedChunks', ?), updated_at = ? WHERE id = ?").bind(chunks.length, now(), id).run();
      await audit(session.username, "index", "knowledge", item.id, { chunks: chunks.length });
      return Response.json({ id, status: "draft", chunks: chunks.length });
    } catch (error) {
      await values.DB.prepare("UPDATE content_items SET status = 'index_failed', metadata = json_set(metadata, '$.indexError', ?), updated_at = ? WHERE id = ?").bind(error instanceof Error ? error.message : "INDEX_FAILED", now(), id).run();
      return jsonError("知识索引失败，可在资源配置完成后重试", 503);
    }
  } catch { return jsonError("未授权", 401); }
}
