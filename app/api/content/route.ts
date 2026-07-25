import { contentTypes, hasUnapprovedClinicalContent } from "@/lib/admin/validation";
import { jsonError, runtime, type ContentType } from "@/lib/admin/store";

function publicContentItem<T extends { body?: unknown; metadata?: unknown }>(item: T) {
  const result = { ...item };
  delete result.body;
  delete result.metadata;
  return result;
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const type = url.searchParams.get("type") as ContentType;
    const id = url.searchParams.get("id");
    if (!contentTypes.has(type)) return jsonError("无效内容类型");
    if (type === "plan") return jsonError("调理方案临床审核流程尚未接入，当前不向用户端提供", 404);
    if (id) {
      const item = await (await runtime()).DB.prepare("SELECT id, type, title, category, summary, body, source, metadata, media_id mediaId, published_at publishedAt FROM content_items WHERE id = ? AND type = ? AND status = 'published'").bind(id, type).first<{ id: string; type: ContentType; title: string; body: string; metadata: string; [key: string]: unknown }>();
      return item && !hasUnapprovedClinicalContent(item) ? Response.json({ item }) : jsonError("内容不存在或已下架", 404);
    }
    const rows = await (await runtime()).DB.prepare("SELECT id, type, title, category, summary, body, metadata, media_id mediaId, published_at publishedAt FROM content_items WHERE type = ? AND status = 'published' ORDER BY published_at DESC").bind(type).all<{ body: string; metadata: string; [key: string]: unknown }>();
    const items = rows.results.filter((item) => !hasUnapprovedClinicalContent(item)).map(publicContentItem);
    return Response.json({ items });
  } catch { return jsonError("内容服务暂不可用", 503); }
}
