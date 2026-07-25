import { runtime } from "@/lib/admin/store";
import { requiresClinicalApproval } from "@/lib/admin/validation";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const values = await runtime();
    const media = await values.DB.prepare("SELECT object_key, content_type, filename FROM media_assets WHERE id = ? AND status = 'ready'").bind(id).first<{ object_key: string; content_type: string; filename: string }>();
    const linkedContent = await values.DB.prepare("SELECT c.type, c.title, c.category, c.summary, c.body, c.source, c.metadata, a.content_id clinicalApprovalId FROM content_items c LEFT JOIN clinical_approvals a ON a.content_id = c.id AND a.content_version = c.version WHERE c.media_id = ? AND c.status = 'published'").bind(id).all<{ type: "article" | "video" | "knowledge" | "plan"; title: string; category: string; summary: string; body: string; source: string; metadata: string; clinicalApprovalId?: string }>();
    const linkedPlans = await values.DB.prepare("SELECT plan.id, a.content_id clinicalApprovalId FROM plan_steps step JOIN content_items plan ON plan.id = step.plan_id LEFT JOIN clinical_approvals a ON a.content_id = plan.id AND a.content_version = plan.version WHERE step.media_id = ? AND plan.status = 'published'").bind(id).all<{ id: string; clinicalApprovalId?: string }>();
    const hasLinks = linkedContent.results.length > 0 || linkedPlans.results.length > 0;
    const contentLinksSafe = linkedContent.results.every((item) => !requiresClinicalApproval(item.type, { ...item, filename: media.filename }) || Boolean(item.clinicalApprovalId));
    const planLinksSafe = linkedPlans.results.every((plan) => Boolean(plan.clinicalApprovalId));
    if (!media || !hasLinks || !contentLinksSafe || !planLinksSafe) return new Response("Not found", { status: 404 });
    if (!media || !values.MEDIA) return new Response("Not found", { status: 404 });
    const object = await values.MEDIA.get(media.object_key);
    if (!object) return new Response("Not found", { status: 404 });
    return new Response(object.body, { headers: { "content-type": media.content_type, "cache-control": "private, max-age=300", "x-content-type-options": "nosniff" } });
  } catch { return new Response("Unavailable", { status: 503 }); }
}
