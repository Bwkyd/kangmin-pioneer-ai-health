import type { ApprovedPlan } from "./api.ts";
import type { RehabMethod } from "./rehab-safety.ts";

export async function findApprovedPlan(syndromeCode: string, method: RehabMethod): Promise<ApprovedPlan | null> {
  try {
    const { runtime } = await import("@/lib/admin/store");
    const { DB } = await runtime();
    const rows = await DB.prepare("SELECT c.id, c.title, c.summary, c.metadata FROM content_items c JOIN clinical_approvals a ON a.content_id = c.id AND a.content_version = c.version WHERE c.type = 'plan' AND c.status = 'published' ORDER BY c.published_at DESC").all<{ id: string; title: string; summary: string; metadata: string }>();
    for (const row of rows.results) {
      const metadata = JSON.parse(row.metadata) as { syndromeCodes?: unknown[]; methodCode?: unknown; risks?: unknown; contraindications?: unknown };
      if (!Array.isArray(metadata.syndromeCodes) || !metadata.syndromeCodes.includes(syndromeCode) || metadata.methodCode !== method) continue;
      const steps = await DB.prepare("SELECT title, instruction FROM plan_steps WHERE plan_id = ? ORDER BY position ASC").bind(row.id).all<{ title: string; instruction: string }>();
      if (steps.results.length === 0 || steps.results.some((step) => !step.title.trim() || !step.instruction.trim())) continue;
      return {
        id: row.id,
        title: row.title,
        summary: row.summary,
        method,
        risks: typeof metadata.risks === "string" ? metadata.risks : "",
        contraindications: typeof metadata.contraindications === "string" ? metadata.contraindications : "",
        steps: steps.results,
      };
    }
  } catch {
    return null;
  }
  return null;
}
