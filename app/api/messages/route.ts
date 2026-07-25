import { HealthRecordError } from "@/lib/health-records/domain";
import { createRuntimeHealthIdentityResolver, requireHealthIdentity } from "@/lib/health-records/identity";
import { jsonError, now, runtime } from "@/lib/admin/store";

async function userId(request: Request) {
  return (await requireHealthIdentity(request, createRuntimeHealthIdentityResolver())).userId;
}

function messageError(error: unknown) {
  if (error instanceof HealthRecordError) return Response.json({ error: { code: error.code, message: error.message } }, { status: error.status });
  return jsonError("消息服务暂不可用", 503);
}

export async function GET(request: Request) {
  try {
    const rows = await (await runtime()).DB.prepare("SELECT n.id, n.title, n.body, n.published_at publishedAt, CASE WHEN r.read_at IS NULL THEN 0 ELSE 1 END isRead FROM notifications n LEFT JOIN notification_reads r ON r.notification_id = n.id AND r.user_id = ? ORDER BY n.published_at DESC").bind(await userId(request)).all();
    return Response.json({ items: rows.results, unread: rows.results.filter((item) => !item.isRead).length });
  } catch (error) { return messageError(error); }
}

export async function PATCH(request: Request) {
  try {
    const { id } = await request.json() as { id?: string };
    if (!id) return jsonError("消息不存在", 404);
    await (await runtime()).DB.prepare("INSERT INTO notification_reads (notification_id, user_id, read_at) SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM notifications WHERE id = ?) ON CONFLICT(notification_id, user_id) DO UPDATE SET read_at = excluded.read_at").bind(id, await userId(request), now(), id).run();
    return Response.json({ id, isRead: true });
  } catch (error) { return messageError(error); }
}
