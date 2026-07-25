import { runtime } from "@/lib/admin/store";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const values = await runtime();
    const media = await values.DB.prepare("SELECT object_key, content_type FROM media_assets WHERE id = ? AND status = 'ready' AND (EXISTS (SELECT 1 FROM content_items WHERE media_id = media_assets.id AND status = 'published') OR EXISTS (SELECT 1 FROM plan_steps step JOIN content_items plan ON plan.id = step.plan_id WHERE step.media_id = media_assets.id AND plan.status = 'published'))").bind(id).first<{ object_key: string; content_type: string }>();
    if (!media || !values.MEDIA) return new Response("Not found", { status: 404 });
    const object = await values.MEDIA.get(media.object_key);
    if (!object) return new Response("Not found", { status: 404 });
    return new Response(object.body, { headers: { "content-type": media.content_type, "cache-control": "private, max-age=300", "x-content-type-options": "nosniff" } });
  } catch { return new Response("Unavailable", { status: 503 }); }
}
