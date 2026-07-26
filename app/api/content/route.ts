import { contentTypes, requiresClinicalApproval } from "@/lib/admin/validation";
import { jsonError, runtime, type ContentType } from "@/lib/admin/store";
import { normalizeVideoTopicType } from "@/lib/content/video-topics";

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
  version: number;
  publishedAt: string;
  clinicalApprovalId?: string;
};

async function publicContentItem(database: D1Database, item: ContentRow, includeBody = false): Promise<Record<string, unknown> | null> {
  const result: Record<string, unknown> = { ...item };
  if (!includeBody) delete result.body;
  delete result.metadata;
  delete result.clinicalApprovalId;
  if (item.type === "plan") {
    let metadata: { methodCode?: unknown; risks?: unknown; contraindications?: unknown } = {};
    try { metadata = JSON.parse(item.metadata) as typeof metadata; } catch { /* invalid metadata cannot be exposed */ }
    // Bind the steps read to the same currently approved version. If the plan
    // changed between the list/detail lookup and this statement, return no
    // plan instead of mixing an old header with a newer step set.
    const steps = await database.prepare("SELECT s.title, s.instruction FROM plan_steps s JOIN content_items c ON c.id = s.plan_id AND c.version = ? AND c.status = 'published' JOIN clinical_approvals a ON a.content_id = c.id AND a.content_version = c.version WHERE s.plan_id = ? ORDER BY s.position ASC").bind(item.version, item.id).all<{ title: string; instruction: string }>();
    if (steps.results.length === 0) return null;
    result.methodCode = typeof metadata.methodCode === "string" ? metadata.methodCode : null;
    result.risks = typeof metadata.risks === "string" ? metadata.risks : "";
    result.contraindications = typeof metadata.contraindications === "string" ? metadata.contraindications : "";
    result.steps = steps.results;
  }
  if (item.type === "video") {
    let metadata: { topicType?: unknown } = {};
    try { metadata = JSON.parse(item.metadata) as typeof metadata; } catch { /* invalid metadata uses the general bucket */ }
    result.topicType = normalizeVideoTopicType(metadata.topicType);
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
      const item = await database.prepare("SELECT c.id, c.type, c.title, c.category, c.summary, c.body, c.source, c.metadata, c.media_id mediaId, c.version version, c.published_at publishedAt, a.content_id clinicalApprovalId FROM content_items c LEFT JOIN clinical_approvals a ON a.content_id = c.id AND a.content_version = c.version WHERE c.id = ? AND c.type = ? AND c.status = 'published'").bind(id, type).first<ContentRow>();
      if (!item || (requiresClinicalApproval(item.type, item) && !item.clinicalApprovalId)) return jsonError("内容不存在或已下架", 404);
      const publicItem = await publicContentItem(database, item, true);
      return publicItem ? Response.json({ item: publicItem }) : jsonError("内容正在更新，请稍后重试", 409);
    }
    const rows = await database.prepare("SELECT c.id, c.type, c.title, c.category, c.summary, c.body, c.source, c.metadata, c.media_id mediaId, c.version version, c.published_at publishedAt, a.content_id clinicalApprovalId FROM content_items c LEFT JOIN clinical_approvals a ON a.content_id = c.id AND a.content_version = c.version WHERE c.type = ? AND c.status = 'published' ORDER BY c.published_at DESC").bind(type).all<ContentRow>();
    const items = (await Promise.all(rows.results.filter((item) => !requiresClinicalApproval(item.type, item) || item.clinicalApprovalId).map((item) => publicContentItem(database, item)))).filter((item): item is Record<string, unknown> => item !== null);
    return Response.json({ items });
  } catch { return jsonError("内容服务暂不可用", 503); }
}
