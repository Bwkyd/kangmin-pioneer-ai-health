import { requireAdmin } from "@/lib/admin/auth";
import { runtime } from "@/lib/admin/store";

export async function GET() {
  try {
    await requireAdmin();
    const { DB } = await runtime();
    const [contents, media, messages] = await Promise.all([
      DB.prepare("SELECT type, status, COUNT(*) count FROM content_items GROUP BY type, status").all(),
      DB.prepare("SELECT COUNT(*) count, COALESCE(SUM(byte_size), 0) bytes FROM media_assets WHERE status = 'ready'").first(),
      DB.prepare("SELECT COUNT(*) count FROM notifications").first(),
    ]);
    return Response.json({ contents: contents.results, media, messages });
  } catch {
    return Response.json({ error: "未授权" }, { status: 401 });
  }
}
