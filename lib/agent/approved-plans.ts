import type { ApprovedPlan } from "./api.ts";
import type { RehabMethod } from "./rehab-safety.ts";

export async function findApprovedPlan(syndromeCode: string, method: RehabMethod): Promise<ApprovedPlan | null> {
  try {
    const { runtime } = await import("@/lib/admin/store");
    const { DB } = await runtime();
    // Read the published row, its current approval, and its steps in one SQL
    // snapshot. A second independent steps query could combine an old approved
    // plan header with steps written after that approval.
    const rows = await DB.prepare("SELECT c.id, c.version content_version, c.title, c.summary, c.metadata, s.title step_title, s.instruction step_instruction FROM content_items c JOIN clinical_approvals a ON a.content_id = c.id AND a.content_version = c.version LEFT JOIN plan_steps s ON s.plan_id = c.id WHERE c.type = 'plan' AND c.status = 'published' ORDER BY c.published_at DESC, s.position ASC").all<{ id: string; content_version: number; title: string; summary: string; metadata: string; step_title: string | null; step_instruction: string | null }>();
    const grouped = new Map<string, { row: (typeof rows.results)[number]; steps: Array<{ title: string; instruction: string }> }>();
    for (const row of rows.results) {
      const current = grouped.get(row.id) ?? { row, steps: [] };
      if (row.step_title !== null && row.step_instruction !== null) current.steps.push({ title: row.step_title, instruction: row.step_instruction });
      grouped.set(row.id, current);
    }
    for (const { row, steps } of grouped.values()) {
      const metadata = JSON.parse(row.metadata) as { syndromeCodes?: unknown[]; methodCode?: unknown; risks?: unknown; contraindications?: unknown };
      if (!Array.isArray(metadata.syndromeCodes) || !metadata.syndromeCodes.includes(syndromeCode) || metadata.methodCode !== method) continue;
      if (steps.length === 0 || steps.some((step) => !step.title.trim() || !step.instruction.trim())) continue;
      return {
        id: row.id,
        contentVersion: row.content_version,
        title: row.title,
        summary: row.summary,
        method,
        risks: typeof metadata.risks === "string" ? metadata.risks : "",
        contraindications: typeof metadata.contraindications === "string" ? metadata.contraindications : "",
        steps,
      };
    }
  } catch {
    return null;
  }
  return null;
}
