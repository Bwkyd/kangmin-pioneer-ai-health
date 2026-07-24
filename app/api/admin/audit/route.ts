import { requireAdmin } from "@/lib/admin/auth";
import { jsonError, runtime } from "@/lib/admin/store";

export async function GET() {
  try {
    await requireAdmin();
    const rows = await (await runtime()).DB.prepare("SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 200").all();
    return Response.json({ items: rows.results });
  } catch { return jsonError("未授权", 401); }
}
