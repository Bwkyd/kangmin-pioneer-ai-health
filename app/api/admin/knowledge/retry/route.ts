import { requireAdmin } from "@/lib/admin/auth";
import { textChunks, writeOptionalVectorIndex } from "@/lib/admin/knowledge-index";
import { hasCurrentClinicalApproval, identifier, jsonError, now, runtime } from "@/lib/admin/store";
import { clinicalApprovalRequiredMessage, requiresClinicalApproval } from "@/lib/admin/validation";

function expectedVersion(request: Request) {
  const match = request.headers.get("if-match")?.match(/^"?(\d+)"?$/);
  return match ? Number(match[1]) : null;
}

async function assertIndexLease(database: D1Database, id: string, version: number, writeToken: string) {
  const row = await database.prepare("SELECT id FROM content_items WHERE id = ? AND version = ? AND status = 'indexing' AND write_token = ?")
    .bind(id, version, writeToken).first<{ id: string }>();
  if (!row) throw new Error("KNOWLEDGE_INDEX_LEASE_LOST");
}

const INDEX_LEASE_MS = 5 * 60 * 1000;

export async function POST(request: Request) {
  try {
    const session = await requireAdmin();
    const { id } = await request.json() as { id?: string };
    const values = await runtime();
    const version = expectedVersion(request);
    if (version === null) return jsonError("请通过 If-Match 提交当前知识资料版本", 428);
    const item = await values.DB.prepare("SELECT id, title, source, body, version, metadata, media_id, status, updated_at FROM content_items WHERE id = ? AND type = 'knowledge'").bind(id).first<{ id: string; title: string; source: string; body: string; version: number; metadata: string; media_id: string | null; status: string; updated_at: string }>();
    if (!item) return jsonError("知识资料不存在", 404);
    if (version !== item.version) return jsonError("内容已被其他管理员更新，请刷新后重试", 409);
    if (requiresClinicalApproval("knowledge", item) && !(await hasCurrentClinicalApproval(values.DB, item.id, item.version))) return jsonError(clinicalApprovalRequiredMessage, 422);
    const writeToken = crypto.randomUUID();
    const timestamp = now();
    const staleBefore = new Date(Date.now() - INDEX_LEASE_MS).toISOString();
    const started = await values.DB.prepare("UPDATE content_items SET status = 'indexing', write_token = ?, updated_at = ? WHERE id = ? AND version = ? AND (status IN ('draft', 'index_failed') OR (status = 'indexing' AND updated_at < ?))").bind(writeToken, timestamp, id, item.version, staleBefore).run();
    if (started.meta.changes === 0) return jsonError(item.status === "indexing" ? "该知识资料仍在索引处理中，请稍后重试" : "内容已被其他管理员更新，请刷新后重试", 409);
    try {
      const chunks = textChunks(item.body || item.title);
      if (chunks.length === 0) throw new Error("KNOWLEDGE_TEXT_EMPTY");
      const previous = JSON.parse(item.metadata || "{}") as { indexedChunks?: number };
      const mode = await writeOptionalVectorIndex(values, item, chunks, Number(previous.indexedChunks ?? 0), writeToken, () => assertIndexLease(values.DB, item.id, item.version, writeToken));
      const timestamp = now();
      const metadata = JSON.stringify({ ...previous, indexedChunks: chunks.length, indexedVersion: item.version, indexMode: mode, indexError: null });
      const lease = "EXISTS (SELECT 1 FROM content_items WHERE id = ? AND version = ? AND status = 'indexing' AND write_token = ?)";
      const statements: D1PreparedStatement[] = [values.DB.prepare(`DELETE FROM knowledge_chunks WHERE knowledge_id = ? AND source_version = ? AND ${lease}`).bind(item.id, item.version, id, item.version, writeToken)];
      chunks.forEach((chunk, position) => statements.push(values.DB.prepare(`INSERT INTO knowledge_chunks (id, knowledge_id, source_version, position, chunk_text, created_at) SELECT ?, ?, ?, ?, ?, ? WHERE ${lease}`).bind(`${item.id}:${position}`, item.id, item.version, position, chunk, timestamp, id, item.version, writeToken)));
      statements.push(
        values.DB.prepare("UPDATE content_items SET status = 'draft', metadata = ?, updated_at = ? WHERE id = ? AND version = ? AND status = 'indexing' AND write_token = ?").bind(metadata, timestamp, id, item.version, writeToken),
        values.DB.prepare("INSERT INTO audit_logs (id, actor, action, entity_type, entity_id, details, created_at) SELECT ?, ?, 'index', 'knowledge', ?, ?, ? WHERE EXISTS (SELECT 1 FROM content_items WHERE id = ? AND version = ? AND status = 'draft' AND write_token = ?)").bind(identifier("audit"), session.username, item.id, JSON.stringify({ chunks: chunks.length, version: item.version, mode }), timestamp, id, item.version, writeToken),
      );
      const results = await values.DB.batch(statements);
      if (results[statements.length - 2].meta.changes === 0) throw new Error("KNOWLEDGE_VERSION_CONFLICT");
      return Response.json({ id, status: "draft", chunks: chunks.length, version: item.version, mode });
    } catch (error) {
      await values.DB.prepare("UPDATE content_items SET status = 'index_failed', metadata = json_set(metadata, '$.indexError', ?), updated_at = ? WHERE id = ? AND version = ? AND status = 'indexing' AND write_token = ?").bind(error instanceof Error ? error.message : "INDEX_FAILED", now(), id, item.version, writeToken).run();
      return jsonError("知识索引失败，可安全重试", 503);
    }
  } catch (error) {
    if (error instanceof Error && error.message === "ADMIN_UNAUTHORIZED") return jsonError("未授权", 401);
    return jsonError("知识索引服务暂不可用", 503);
  }
}
