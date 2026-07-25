import { contentTypes, requiresClinicalApproval } from "@/lib/admin/validation";
import { jsonError, runtime, type ContentType } from "@/lib/admin/store";

type ContentRow = {
  id: string;
  type: ContentType;
  title: string;
  category: string;
  summary: string;
  body: string;
  source: string;
  metadata: string;
  mediaId: string | null;
  publishedAt: string;
  clinicalApprovalId?: string;
};

async function publicContentItem(database: D1Database, item: ContentRow, includeBody = false) {
  const result: Record<string, unknown> = { ...item };
  if (!includeBody) delete result.body;
  delete result.metadata;
  delete result.clinicalApprovalId;
  if (item.type === "plan") {
    let metadata: { methodCode?: unknown; risks?: unknown; contraindications?: unknown } = {};
    try { metadata = JSON.parse(item.metadata) as typeof metadata; } catch { /* invalid metadata cannot be exposed */ }
    const steps = await database.prepare("SELECT title, instruction FROM plan_steps WHERE plan_id = ? ORDER BY position ASC").bind(item.id).all<{ title: string; instruction: string }>();
    result.methodCode = typeof metadata.methodCode === "string" ? metadata.methodCode : null;
    result.risks = typeof metadata.risks === "string" ? metadata.risks : "";
    result.contraindications = typeof metadata.contraindications === "string" ? metadata.contraindications : "";
    result.steps = steps.results;
  }
  return result;
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const type = url.searchParams.get("type") as ContentType;
    const id = url.searchParams.get("id");
    if (!contentTypes.has(type)) return jsonError("无效内容类型");
    const database = (await runtime()).DB;
    if (id) {
      const item = await database.prepare("SELECT c.id, c.type, c.title, c.category, c.summary, c.body, c.source, c.metadata, c.media_id mediaId, c.published_at publishedAt, a.content_id clinicalApprovalId FROM content_items c LEFT JOIN clinical_approvals a ON a.content_id = c.id AND a.content_version = c.version WHERE c.id = ? AND c.type = ? AND c.status = 'published'").bind(id, type).first<ContentRow>();
      return item && (!requiresClinicalApproval(item.type, item) || item.clinicalApprovalId) ? Response.json({ item: await publicContentItem(database, item, true) }) : jsonError("内容不存在或已下架", 404);
    }
    const rows = await database.prepare("SELECT c.id, c.type, c.title, c.category, c.summary, c.body, c.source, c.metadata, c.media_id mediaId, c.published_at publishedAt, a.content_id clinicalApprovalId FROM content_items c LEFT JOIN clinical_approvals a ON a.content_id = c.id AND a.content_version = c.version WHERE c.type = ? AND c.status = 'published' ORDER BY c.published_at DESC").bind(type).all<ContentRow>();
    const items = await Promise.all(rows.results.filter((item) => !requiresClinicalApproval(item.type, item) || item.clinicalApprovalId).map((item) => publicContentItem(database, item)));
    return Response.json({ items });
  } catch { return jsonError("内容服务暂不可用", 503); }
}
