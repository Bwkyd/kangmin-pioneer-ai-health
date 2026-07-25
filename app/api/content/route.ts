import { contentTypes, requiresClinicalApproval } from "@/lib/admin/validation";
import { jsonError, runtime, type ContentType } from "@/lib/admin/store";

function publicContentItem<T extends { body?: unknown; metadata?: unknown; clinicalApprovalId?: unknown }>(item: T, includeBody = false) {
  const result = { ...item };
  if (!includeBody) delete result.body;
  delete result.metadata;
  delete result.clinicalApprovalId;
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
      const item = await (await runtime()).DB.prepare("SELECT c.id, c.type, c.title, c.category, c.summary, c.body, c.source, c.metadata, c.media_id mediaId, c.published_at publishedAt, a.content_id clinicalApprovalId FROM content_items c LEFT JOIN clinical_approvals a ON a.content_id = c.id AND a.content_version = c.version WHERE c.id = ? AND c.type = ? AND c.status = 'published'").bind(id, type).first<{ id: string; type: ContentType; title: string; body: string; metadata: string; clinicalApprovalId?: string; [key: string]: unknown }>();
      return item && (!requiresClinicalApproval(item.type, item) || item.clinicalApprovalId) ? Response.json({ item: publicContentItem(item, true) }) : jsonError("内容不存在或已下架", 404);
    }
    const rows = await (await runtime()).DB.prepare("SELECT c.id, c.type, c.title, c.category, c.summary, c.body, c.source, c.metadata, c.media_id mediaId, c.published_at publishedAt, a.content_id clinicalApprovalId FROM content_items c LEFT JOIN clinical_approvals a ON a.content_id = c.id AND a.content_version = c.version WHERE c.type = ? AND c.status = 'published' ORDER BY c.published_at DESC").bind(type).all<{ body: string; metadata: string; type: ContentType; clinicalApprovalId?: string; [key: string]: unknown }>();
    const items = rows.results.filter((item) => !requiresClinicalApproval(item.type, item) || item.clinicalApprovalId).map((item) => publicContentItem(item));
    return Response.json({ items });
  } catch { return jsonError("内容服务暂不可用", 503); }
}
