import { cookies } from "next/headers";
import { jsonError, now, runtime } from "@/lib/admin/store";

const USER_COOKIE = "kangmin_message_user";

async function userId() {
  const cookieStore = await cookies();
  const existing = cookieStore.get(USER_COOKIE)?.value;
  if (existing && /^user_[0-9a-f-]{36}$/.test(existing)) return existing;
  const created = `user_${crypto.randomUUID()}`;
  cookieStore.set(USER_COOKIE, created, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
  });
  return created;
}

export async function GET() {
  try {
    const rows = await (await runtime()).DB.prepare("SELECT n.id, n.title, n.body, n.published_at publishedAt, CASE WHEN r.read_at IS NULL THEN 0 ELSE 1 END isRead FROM notifications n LEFT JOIN notification_reads r ON r.notification_id = n.id AND r.user_id = ? ORDER BY n.published_at DESC").bind(await userId()).all();
    return Response.json({ items: rows.results, unread: rows.results.filter((item) => !item.isRead).length });
  } catch { return jsonError("消息服务暂不可用", 503); }
}

export async function PATCH(request: Request) {
  try {
    const { id } = await request.json() as { id?: string };
    if (!id) return jsonError("消息不存在", 404);
    await (await runtime()).DB.prepare("INSERT INTO notification_reads (notification_id, user_id, read_at) SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM notifications WHERE id = ?) ON CONFLICT(notification_id, user_id) DO UPDATE SET read_at = excluded.read_at").bind(id, await userId(), now(), id).run();
    return Response.json({ id, isRead: true });
  } catch { return jsonError("消息更新失败", 400); }
}
