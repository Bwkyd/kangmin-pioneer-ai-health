import { requireAdmin } from "@/lib/admin/auth";
import { adminRouteError, identifier, jsonError, now, runtime } from "@/lib/admin/store";
import { cleanText } from "@/lib/admin/validation";

function expectedVersion(request: Request) {
  const match = request.headers.get("if-match")?.match(/^"?(\d+)"?$/);
  return match ? Number(match[1]) : null;
}

export async function GET(request: Request) {
  try {
    await requireAdmin();
    const planId = new URL(request.url).searchParams.get("planId");
    const rows = await (await runtime()).DB.prepare("SELECT * FROM plan_steps WHERE plan_id = ? ORDER BY position").bind(planId).all();
    return Response.json({ steps: rows.results });
  } catch (error) { return adminRouteError(error); }
}

export async function POST(request: Request) {
  try {
    const session = await requireAdmin();
    const body = await request.json() as Record<string, unknown>;
    const planId = cleanText(body.planId, 120);
    const values = await runtime();
    const plan = await values.DB.prepare("SELECT id, status, version FROM content_items WHERE id = ? AND type = 'plan'").bind(planId).first<{ id: string; status: string; version: number }>();
    if (!plan) return jsonError("调理方案不存在", 404);
    if (plan.status === "published") return jsonError("已发布方案不能直接追加步骤，请先下架并重新审核", 409);
    const version = expectedVersion(request);
    if (version === null) return jsonError("请通过 If-Match 提交当前方案版本", 428);
    if (version !== plan.version) return jsonError("方案已被其他管理员更新，请刷新后重试", 409);
    const position = Number(body.position);
    if (!Number.isSafeInteger(position) || position < 1) return jsonError("步骤位置必须是正整数", 422);
    const title = cleanText(body.title, 160);
    const instruction = cleanText(body.instruction, 4000);
    if (!title || !instruction) return jsonError("步骤标题和说明不能为空", 422);
    const mediaId = cleanText(body.mediaId, 120) || null;
    if (mediaId) {
      const media = await values.DB.prepare("SELECT kind, status FROM media_assets WHERE id = ?").bind(mediaId).first<{ kind: string; status: string }>();
      if (!media || media.kind !== "video" || media.status !== "ready") return jsonError("步骤只能关联可用的视频素材", 422);
    }
    const id = identifier("step");
    const timestamp = now();
    const nextVersion = plan.version + 1;
    const results = await values.DB.batch([
      values.DB.prepare("UPDATE content_items SET status = 'draft', published_at = NULL, version = version + 1, updated_at = ? WHERE id = ? AND type = 'plan' AND version = ? AND status IN ('draft', 'offline', 'index_failed')")
        .bind(timestamp, planId, plan.version),
      values.DB.prepare("DELETE FROM clinical_approvals WHERE content_id = ? AND content_version = ? AND EXISTS (SELECT 1 FROM content_items WHERE id = ? AND version = ? AND status = 'draft')")
        .bind(planId, plan.version, planId, nextVersion),
      values.DB.prepare("INSERT INTO plan_steps (id, plan_id, position, title, instruction, media_id, created_at, updated_at) SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM content_items WHERE id = ? AND type = 'plan' AND version = ? AND status = 'draft')")
        .bind(id, planId, position, title, instruction, mediaId, timestamp, timestamp, planId, nextVersion),
      values.DB.prepare("INSERT INTO audit_logs (id, actor, action, entity_type, entity_id, details, created_at) SELECT ?, ?, 'create_step', 'plan', ?, ?, ? WHERE EXISTS (SELECT 1 FROM content_items WHERE id = ? AND version = ? AND status = 'draft')")
        .bind(identifier("audit"), session.username, planId, JSON.stringify({ stepId: id, contentVersion: nextVersion }), timestamp, planId, nextVersion),
    ]);
    if (results[0].meta.changes === 0 || results[2].meta.changes === 0) return jsonError("方案已被其他管理员更新，请刷新后重试", 409);
    return Response.json({ id, version: nextVersion }, { status: 201 });
  } catch (error) { return adminRouteError(error); }
}
