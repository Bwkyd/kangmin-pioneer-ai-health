import { requireAdmin } from "@/lib/admin/auth";
import { textChunks, writeOptionalVectorIndex } from "@/lib/admin/knowledge-index";
import { identifier, jsonError, now, runtime } from "@/lib/admin/store";
import { clinicalApprovalRequiredMessage, hasUnapprovedClinicalContent } from "@/lib/admin/validation";

export async function POST(request: Request) {
  try {
    const session = await requireAdmin();
    const { id } = await request.json() as { id?: string };
    const values = await runtime();
    const item = await values.DB.prepare("SELECT id, title, source, body, version, metadata, media_id FROM content_items WHERE id = ? AND type = 'knowledge'").bind(id).first<{ id: string; title: string; source: string; body: string; version: number; metadata: string; media_id: string | null }>();
    if (!item) return jsonError("知识资料不存在", 404);
    if (hasUnapprovedClinicalContent(item)) return jsonError(clinicalApprovalRequiredMessage, 422);
    await values.DB.prepare("UPDATE content_items SET status = 'indexing', updated_at = ? WHERE id = ?").bind(now(), id).run();
    try {
      const chunks = textChunks(item.body || item.title);
      if (chunks.length === 0) throw new Error("KNOWLEDGE_TEXT_EMPTY");
      const previous = JSON.parse(item.metadata || "{}") as { indexedChunks?: number };
      const mode = await writeOptionalVectorIndex(values, item, chunks, Number(previous.indexedChunks ?? 0));
      const timestamp = now();
      const metadata = JSON.stringify({ ...previous, indexedChunks: chunks.length, indexedVersion: item.version, indexMode: mode, indexError: null });
      const statements: D1PreparedStatement[] = [values.DB.prepare("DELETE FROM knowledge_chunks WHERE knowledge_id = ?").bind(item.id)];
      chunks.forEach((chunk, position) => statements.push(values.DB.prepare("INSERT INTO knowledge_chunks (id, knowledge_id, source_version, position, chunk_text, created_at) VALUES (?, ?, ?, ?, ?, ?)").bind(`${item.id}:${position}`, item.id, item.version, position, chunk, timestamp)));
      statements.push(
        values.DB.prepare("UPDATE content_items SET status = 'draft', metadata = ?, updated_at = ? WHERE id = ?").bind(metadata, timestamp, id),
        values.DB.prepare("INSERT INTO audit_logs (id, actor, action, entity_type, entity_id, details, created_at) VALUES (?, ?, 'index', 'knowledge', ?, ?, ?)").bind(identifier("audit"), session.username, item.id, JSON.stringify({ chunks: chunks.length, version: item.version, mode }), timestamp),
      );
      await values.DB.batch(statements);
      return Response.json({ id, status: "draft", chunks: chunks.length, version: item.version, mode });
    } catch (error) {
      await values.DB.prepare("UPDATE content_items SET status = 'index_failed', metadata = json_set(metadata, '$.indexError', ?), updated_at = ? WHERE id = ?").bind(error instanceof Error ? error.message : "INDEX_FAILED", now(), id).run();
      return jsonError("知识索引失败，可安全重试", 503);
    }
  } catch (error) {
    if (error instanceof Error && error.message === "ADMIN_UNAUTHORIZED") return jsonError("未授权", 401);
    return jsonError("知识索引服务暂不可用", 503);
  }
}
