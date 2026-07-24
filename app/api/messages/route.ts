import { jsonError, now, runtime } from "@/lib/admin/store";

function userId(request: Request) {
  return request.headers.get("x-user-id")?.trim().slice(0, 120) || "anonymous";
}

export async function GET(request: Request) {
  try {
    const rows = await (await runtime()).DB.prepare("SELECT n.id, n.title, n.body, n.published_at publishedAt, CASE WHEN r.read_at IS NULL THEN 0 ELSE 1 END isRead FROM notifications n LEFT JOIN notification_reads r ON r.notification_id = n.id AND r.user_id = ? ORDER BY n.published_at DESC").bind(userId(request)).all();
    return Response.json({ items: rows.results, unread: rows.results.filter((item) => !item.isRead).length });
  } catch { return jsonError("消息服务暂不可用", 503); }
}

export async function PATCH(request: Request) {
  try {
    const { id } = await request.json() as { id?: string };
    if (!id) return jsonError("消息不存在", 404);
    await (await runtime()).DB.prepare("INSERT INTO notification_reads (notification_id, user_id, read_at) VALUES (?, ?, ?) ON CONFLICT(notification_id, user_id) DO UPDATE SET read_at = excluded.read_at").bind(id, userId(request), now()).run();
    return Response.json({ id, isRead: true });
  } catch { return jsonError("消息更新失败", 400); }
}
