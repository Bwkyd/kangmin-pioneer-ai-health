import { requireAdmin } from "@/lib/admin/auth";
import { adminRouteError, identifier, jsonError, now, runtime, type ContentType } from "@/lib/admin/store";
import { contentTypes, parseMetadata } from "@/lib/admin/validation";

function clinicalApproverAllowed(username: string, configured: string | undefined) {
  return Boolean(configured?.split(",").map((item) => item.trim()).filter(Boolean).includes(username));
}

function expectedVersion(request: Request) {
  const match = request.headers.get("if-match")?.match(/^"?(\d+)"?$/);
  return match ? Number(match[1]) : null;
}

export async function GET(request: Request) {
  try {
    await requireAdmin();
    const contentId = new URL(request.url).searchParams.get("contentId")?.trim();
    if (!contentId) return jsonError("请提供 contentId");
    const { DB } = await runtime();
    const approval = await DB.prepare("SELECT a.content_id contentId, a.content_version contentVersion, a.approver, a.approved_at approvedAt FROM clinical_approvals a JOIN content_items c ON c.id = a.content_id AND c.version = a.content_version WHERE a.content_id = ?").bind(contentId).first();
    return Response.json({ approval: approval ?? null });
  } catch (error) {
    return adminRouteError(error);
  }
}

export async function POST(request: Request) {
  try {
    const session = await requireAdmin();
    const { DB, CLINICAL_APPROVER_USERS } = await runtime();
    if (!clinicalApproverAllowed(session.username, CLINICAL_APPROVER_USERS)) return jsonError("当前账号不是已配置的临床审核人", 403);
    const body = await request.json() as Record<string, unknown>;
    const contentId = typeof body.contentId === "string" ? body.contentId.trim() : "";
    if (!contentId) return jsonError("请提供 contentId");
    const version = expectedVersion(request);
    if (version === null) return jsonError("请通过 If-Match 提交当前内容版本", 428);
    const item = await DB.prepare("SELECT id, type, status, version, metadata FROM content_items WHERE id = ?").bind(contentId).first<{ id: string; type: ContentType; status: string; version: number; metadata: string }>();
    if (!item || !contentTypes.has(item.type)) return jsonError("内容不存在", 404);
    if (version !== item.version) return jsonError("内容已被其他管理员更新，请刷新后重试", 409);
    if (item.status === "published") return jsonError("已发布内容不能在原版本上补充审核，请先形成新版本", 409);
    const metadata = parseMetadata(item.metadata, item.type);
    if (item.type === "plan" && (!metadata.methodCode || !metadata.risks || !metadata.contraindications || metadata.syndromeCodes.length === 0)) {
      return jsonError("调理方案必须先补齐受控方法、风险、禁忌和适用证型，才能提交临床审核", 422);
    }
    if (item.type === "plan") {
      const steps = await DB.prepare("SELECT COUNT(*) count, SUM(CASE WHEN title = '' OR instruction = '' THEN 1 ELSE 0 END) invalid FROM plan_steps WHERE plan_id = ?").bind(contentId).first<{ count: number; invalid: number }>();
      if (Number(steps?.count ?? 0) < 1) return jsonError("调理方案至少需要一个有效步骤，才能提交临床审核", 422);
      if (Number(steps?.invalid ?? 0) > 0) return jsonError("调理方案步骤标题和说明不能为空", 422);
    }
    const timestamp = now();
    const results = await DB.batch([
      DB.prepare("INSERT INTO clinical_approvals (content_id, content_version, approver, approved_at) SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM content_items WHERE id = ? AND version = ? AND status IN ('draft', 'offline', 'index_failed')) ON CONFLICT(content_id) DO UPDATE SET content_version = excluded.content_version, approver = excluded.approver, approved_at = excluded.approved_at").bind(contentId, item.version, session.username, timestamp, contentId, item.version),
      DB.prepare("INSERT INTO audit_logs (id, actor, action, entity_type, entity_id, details, created_at) SELECT ?, ?, 'clinical_approve', ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM content_items WHERE id = ? AND version = ? AND status IN ('draft', 'offline', 'index_failed'))").bind(identifier("audit"), session.username, item.type, contentId, JSON.stringify({ contentVersion: item.version }), timestamp, contentId, item.version),
    ]);
    if (results[0].meta.changes === 0) return jsonError("内容已被其他管理员更新，请刷新后重试", 409);
    return Response.json({ contentId, contentVersion: item.version, approver: session.username, approvedAt: timestamp }, { status: 201 });
  } catch (error) {
    return adminRouteError(error, "临床审核服务暂不可用");
  }
}
