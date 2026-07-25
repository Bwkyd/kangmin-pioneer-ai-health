import { requireAdmin } from "@/lib/admin/auth";
import { adminRouteError, identifier, jsonError, now, runtime, type ContentType } from "@/lib/admin/store";
import { contentTypes, parseMetadata } from "@/lib/admin/validation";

function clinicalApproverAllowed(username: string, configured: string | undefined) {
  return Boolean(configured?.split(",").map((item) => item.trim()).filter(Boolean).includes(username));
}

export async function GET(request: Request) {
  try {
    await requireAdmin();
    const contentId = new URL(request.url).searchParams.get("contentId")?.trim();
    if (!contentId) return jsonError("请提供 contentId");
    const { DB } = await runtime();
    const approval = await DB.prepare("SELECT content_id contentId, content_version contentVersion, approver, approved_at approvedAt FROM clinical_approvals WHERE content_id = ?").bind(contentId).first();
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
    const item = await DB.prepare("SELECT id, type, status, version, metadata FROM content_items WHERE id = ?").bind(contentId).first<{ id: string; type: ContentType; status: string; version: number; metadata: string }>();
    if (!item || !contentTypes.has(item.type)) return jsonError("内容不存在", 404);
    if (item.status === "published") return jsonError("已发布内容不能在原版本上补充审核，请先形成新版本", 409);
    const metadata = parseMetadata(item.metadata);
    if (item.type === "plan" && (!metadata.methodCode || !metadata.risks || !metadata.contraindications || metadata.syndromeCodes.length === 0)) {
      return jsonError("调理方案必须先补齐受控方法、风险、禁忌和适用证型，才能提交临床审核", 422);
    }
    const timestamp = now();
    await DB.batch([
      DB.prepare("INSERT INTO clinical_approvals (content_id, content_version, approver, approved_at) VALUES (?, ?, ?, ?) ON CONFLICT(content_id) DO UPDATE SET content_version = excluded.content_version, approver = excluded.approver, approved_at = excluded.approved_at").bind(contentId, item.version, session.username, timestamp),
      DB.prepare("INSERT INTO audit_logs (id, actor, action, entity_type, entity_id, details, created_at) VALUES (?, ?, 'clinical_approve', ?, ?, ?, ?)").bind(identifier("audit"), session.username, item.type, contentId, JSON.stringify({ contentVersion: item.version }), timestamp),
    ]);
    return Response.json({ contentId, contentVersion: item.version, approver: session.username, approvedAt: timestamp }, { status: 201 });
  } catch (error) {
    return adminRouteError(error, "临床审核服务暂不可用");
  }
}
