import { requireAdmin } from "@/lib/admin/auth";
import { adminRouteError, identifier, jsonError, now, runtime, type ContentType } from "@/lib/admin/store";
import { clinicalCandidateApprovalProblem, clinicalCandidateContentProblem, clinicalCandidateProblem, contentTypes, parseMetadata } from "@/lib/admin/validation";

function clinicalApproverAllowed(username: string, configured: string | undefined) {
  return Boolean(configured?.split(",").map((item) => item.trim()).filter(Boolean).includes(username));
}

function expectedVersion(request: Request) {
  const match = request.headers.get("if-match")?.match(/^"?(\d+)"?$/);
  return match ? Number(match[1]) : null;
}

export async function GET(request: Request) {
  try {
    await requireAdmin();
    const contentId = new URL(request.url).searchParams.get("contentId")?.trim();
    if (!contentId) return jsonError("请提供 contentId");
    const { DB } = await runtime();
    const review = await DB.prepare("SELECT c.id contentId, c.version contentVersion, c.clinical_review_status clinicalReviewStatus, c.clinical_candidate_kind candidateKind, c.clinical_change_diff changeDiff, c.clinical_reviewer reviewer, c.clinical_reviewed_at reviewedAt, a.approver, a.approved_at approvedAt FROM content_items c LEFT JOIN clinical_approvals a ON a.content_id = c.id AND a.content_version = c.version WHERE c.id = ?").bind(contentId).first<{ contentId: string; contentVersion: number; clinicalReviewStatus: string; candidateKind: string | null; changeDiff: string; reviewer: string | null; reviewedAt: string | null; approver: string | null; approvedAt: string | null }>();
    if (!review) return Response.json({ approval: null, review: null });
    const approval = review.approver ? { contentId: review.contentId, contentVersion: review.contentVersion, approver: review.approver, approvedAt: review.approvedAt } : null;
    return Response.json({ approval, review: { contentId: review.contentId, contentVersion: review.contentVersion, status: review.clinicalReviewStatus, candidateKind: review.candidateKind, changeDiff: review.changeDiff, reviewer: review.reviewer, reviewedAt: review.reviewedAt } });
  } catch (error) {
    return adminRouteError(error);
  }
}

export async function POST(request: Request) {
  try {
    const session = await requireAdmin();
    const { DB, CLINICAL_APPROVER_USERS } = await runtime();
    if (!clinicalApproverAllowed(session.username, CLINICAL_APPROVER_USERS)) return jsonError("当前账号不是已配置的临床审核人", 403);
    const body = await request.json() as Record<string, unknown>;
    const contentId = typeof body.contentId === "string" ? body.contentId.trim() : "";
    if (!contentId) return jsonError("请提供 contentId");
    const version = expectedVersion(request);
    if (version === null) return jsonError("请通过 If-Match 提交当前内容版本", 428);
    const item = await DB.prepare("SELECT id, type, status, version, source, metadata, clinical_candidate_kind candidateKind, clinical_change_diff changeDiff, clinical_review_status clinicalReviewStatus FROM content_items WHERE id = ?").bind(contentId).first<{ id: string; type: ContentType; status: string; version: number; source: string; metadata: string; candidateKind: string | null; changeDiff: string; clinicalReviewStatus: string }>();
    if (!item || !contentTypes.has(item.type)) return jsonError("内容不存在", 404);
    if (version !== item.version) return jsonError("内容已被其他管理员更新，请刷新后重试", 409);
    if (item.status === "published") return jsonError("已发布内容不能在原版本上补充审核，请先形成新版本", 409);
    const candidateProblem = clinicalCandidateProblem(item.candidateKind, item.changeDiff, item.source);
    if (candidateProblem) return jsonError(candidateProblem, 422);
    const metadata = parseMetadata(item.metadata, item.type);
    if (item.type === "plan" && (!metadata.methodCode || !metadata.risks || !metadata.contraindications || metadata.syndromeCodes.length === 0)) {
      return jsonError("调理方案必须先补齐受控方法、风险、禁忌和适用证型，才能提交临床审核", 422);
    }
    const candidateContentProblem = clinicalCandidateContentProblem(item.candidateKind, item.metadata, item.type);
    if (candidateContentProblem) return jsonError(candidateContentProblem, 422);
    const candidateApprovalProblem = clinicalCandidateApprovalProblem(item.candidateKind, item.metadata, item.type);
    if (candidateApprovalProblem) return jsonError(candidateApprovalProblem, 422);
    if (item.type === "plan") {
      const steps = await DB.prepare("SELECT COUNT(*) count, SUM(CASE WHEN title = '' OR instruction = '' THEN 1 ELSE 0 END) invalid FROM plan_steps WHERE plan_id = ?").bind(contentId).first<{ count: number; invalid: number }>();
      if (Number(steps?.count ?? 0) < 1) return jsonError("调理方案至少需要一个有效步骤，才能提交临床审核", 422);
      if (Number(steps?.invalid ?? 0) > 0) return jsonError("调理方案步骤标题和说明不能为空", 422);
    }
    const timestamp = now();
    const results = await DB.batch([
      DB.prepare("UPDATE content_items SET clinical_review_status = 'approved', clinical_reviewer = ?, clinical_reviewed_at = ? WHERE id = ? AND version = ? AND status IN ('draft', 'offline', 'index_failed')").bind(session.username, timestamp, contentId, item.version),
      DB.prepare("INSERT INTO clinical_approvals (content_id, content_version, approver, approved_at) SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM content_items WHERE id = ? AND version = ? AND status IN ('draft', 'offline', 'index_failed') AND clinical_review_status = 'approved' AND clinical_reviewer = ? AND clinical_reviewed_at = ?) ON CONFLICT(content_id) DO UPDATE SET content_version = excluded.content_version, approver = excluded.approver, approved_at = excluded.approved_at").bind(contentId, item.version, session.username, timestamp, contentId, item.version, session.username, timestamp),
      DB.prepare("INSERT INTO audit_logs (id, actor, action, entity_type, entity_id, details, created_at) SELECT ?, ?, 'clinical_approve', ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM content_items WHERE id = ? AND version = ? AND status IN ('draft', 'offline', 'index_failed') AND clinical_review_status = 'approved' AND clinical_reviewer = ? AND clinical_reviewed_at = ?)").bind(identifier("audit"), session.username, item.type, contentId, JSON.stringify({ contentVersion: item.version, candidateKind: item.candidateKind, changeDiff: item.changeDiff, reviewStatus: "approved" }), timestamp, contentId, item.version, session.username, timestamp),
    ]);
    if (results[0].meta.changes === 0 || results[1].meta.changes === 0) return jsonError("内容已被其他管理员更新，请刷新后重试", 409);
    return Response.json({ contentId, contentVersion: item.version, approver: session.username, approvedAt: timestamp, reviewStatus: "approved" }, { status: 201 });
  } catch (error) {
    return adminRouteError(error, "临床审核服务暂不可用");
  }
}
