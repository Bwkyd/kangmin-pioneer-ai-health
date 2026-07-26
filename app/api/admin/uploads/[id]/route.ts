import { requireAdmin } from "@/lib/admin/auth";
import { adminRouteError, runtime } from "@/lib/admin/store";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    await requireAdmin();
    const { id } = await context.params;
    const values = await runtime();
    if (!values.MEDIA) return new Response("文件存储尚未配置", { status: 503 });
    const media = await values.DB.prepare("SELECT object_key, content_type, filename FROM media_assets WHERE id = ? AND kind = 'image' AND status = 'ready'")
      .bind(id)
      .first<{ object_key: string; content_type: string; filename: string }>();
    if (!media) return new Response("Not found", { status: 404 });
    const object = await values.MEDIA.get(media.object_key);
    if (!object) return new Response("Not found", { status: 404 });
    return new Response(object.body, {
      headers: {
        "cache-control": "private, no-store",
        "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(media.filename)}`,
        "content-type": media.content_type,
        "x-content-type-options": "nosniff",
      },
    });
  } catch (error) {
    return adminRouteError(error);
  }
}
