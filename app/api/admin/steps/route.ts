import { requireAdmin } from "@/lib/admin/auth";
import { adminRouteError, identifier, jsonError, now, runtime } from "@/lib/admin/store";
import { cleanText } from "@/lib/admin/validation";

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
    const plan = await values.DB.prepare("SELECT id FROM content_items WHERE id = ? AND type = 'plan'").bind(planId).first();
    if (!plan) return jsonError("调理方案不存在", 404);
    const id = identifier("step");
    const timestamp = now();
    await values.DB.batch([
      values.DB.prepare("INSERT INTO plan_steps (id, plan_id, position, title, instruction, media_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(id, planId, Number(body.position) || 1, cleanText(body.title, 160), cleanText(body.instruction, 4000), cleanText(body.mediaId, 120) || null, timestamp, timestamp),
      values.DB.prepare("INSERT INTO audit_logs (id, actor, action, entity_type, entity_id, details, created_at) VALUES (?, ?, 'create_step', 'plan', ?, ?, ?)").bind(identifier("audit"), session.username, planId, JSON.stringify({ stepId: id }), timestamp),
    ]);
    return Response.json({ id }, { status: 201 });
  } catch (error) { return adminRouteError(error); }
}
