import { requireAdmin } from "@/lib/admin/auth";
import { adminRouteError, executeIdempotent, hasCurrentClinicalApproval, identifier, jsonError, now, runtime, stableIdentifier, type ContentStatus, type ContentType } from "@/lib/admin/store";
import { cleanText, contentTypes, clinicalApprovalRequiredMessage, parseMetadata, publishProblem, requiresClinicalApproval } from "@/lib/admin/validation";

type ContentRow = { id: string; type: ContentType; title: string; category: string; summary: string; body: string; source: string; status: ContentStatus; version: number; media_id: string | null; metadata: string; published_at: string | null; created_at: string; updated_at: string };

function expectedVersion(request: Request) {
  const match = request.headers.get("if-match")?.match(/^"?(\d+)"?$/);
  return match ? Number(match[1]) : null;
}

function serialize(row: ContentRow) {
  return { ...row, mediaId: row.media_id, metadata: JSON.parse(row.metadata), publishedAt: row.published_at, createdAt: row.created_at, updatedAt: row.updated_at };
}

export async function GET(request: Request) {
  try {
    await requireAdmin();
    const type = new URL(request.url).searchParams.get("type") as ContentType | null;
    if (type && !contentTypes.has(type)) return jsonError("无效内容类型");
    const { DB } = await runtime();
    const query = type
      ? DB.prepare("SELECT * FROM content_items WHERE type = ? ORDER BY updated_at DESC").bind(type)
      : DB.prepare("SELECT * FROM content_items ORDER BY updated_at DESC");
    const rows = await query.all<ContentRow>();
    return Response.json({ items: rows.results.map(serialize) });
  } catch (error) {
    return adminRouteError(error);
  }
}

export async function POST(request: Request) {
  try {
    const session = await requireAdmin();
    const body = await request.json() as Record<string, unknown>;
    const type = body.type as ContentType;
    if (!contentTypes.has(type)) return jsonError("无效内容类型");
    const title = cleanText(body.title, 160);
    if (!title) return jsonError("标题不能为空");
    const idempotencyKey = request.headers.get("Idempotency-Key");
    return executeIdempotent(session.username, idempotencyKey, async (lease) => {
      const id = lease ? await stableIdentifier(type, `${session.username}:${idempotencyKey}:${type}`) : identifier(type);
      const timestamp = now();
      const metadata = parseMetadata(body.metadata);
      const { DB } = await runtime();
      const insert = lease
        ? DB.prepare("INSERT OR IGNORE INTO content_items (id, type, title, category, summary, body, source, status, version, media_id, metadata, created_at, updated_at) SELECT ?, ?, ?, ?, ?, ?, ?, 'draft', 1, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM idempotency_keys WHERE key = ? AND actor = ? AND response = ?)").bind(id, type, title, cleanText(body.category, 80) || "未分类", cleanText(body.summary, 1000), cleanText(body.body), cleanText(body.source, 1000), cleanText(body.mediaId, 120) || null, JSON.stringify(metadata), timestamp, timestamp, idempotencyKey, session.username, lease.marker)
        : DB.prepare("INSERT INTO content_items (id, type, title, category, summary, body, source, status, version, media_id, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', 1, ?, ?, ?, ?)").bind(id, type, title, cleanText(body.category, 80) || "未分类", cleanText(body.summary, 1000), cleanText(body.body), cleanText(body.source, 1000), cleanText(body.mediaId, 120) || null, JSON.stringify(metadata), timestamp, timestamp);
      const auditStatement = lease
        ? DB.prepare("INSERT INTO audit_logs (id, actor, action, entity_type, entity_id, details, created_at) SELECT ?, ?, 'create', ?, ?, '{}', ? WHERE EXISTS (SELECT 1 FROM idempotency_keys WHERE key = ? AND actor = ? AND response = ?)").bind(identifier("audit"), session.username, type, id, timestamp, idempotencyKey, session.username, lease.marker)
        : DB.prepare("INSERT INTO audit_logs (id, actor, action, entity_type, entity_id, details, created_at) VALUES (?, ?, 'create', ?, ?, '{}', ?)").bind(identifier("audit"), session.username, type, id, timestamp);
      await DB.batch([
        insert,
        auditStatement,
      ]);
      return Response.json({ id, status: "draft" }, { status: 201 });
    });
  } catch (error) {
    return adminRouteError(error);
  }
}

export async function PATCH(request: Request) {
  try {
    const session = await requireAdmin();
    const body = await request.json() as Record<string, unknown>;
    const id = cleanText(body.id, 120);
    const action = cleanText(body.action, 40);
    const { DB } = await runtime();
    const item = await DB.prepare("SELECT * FROM content_items WHERE id = ?").bind(id).first<ContentRow>();
    if (!item) return jsonError("内容不存在", 404);
    const version = expectedVersion(request);
    if (version === null) return jsonError("请通过 If-Match 提交当前内容版本", 428);
    if (version !== item.version) return jsonError("内容已被其他管理员更新，请刷新后重试", 409);
    if (action === "publish") {
      const stepStats = item.type === "plan"
        ? await DB.prepare("SELECT COUNT(*) count, SUM(CASE WHEN title = '' OR instruction = '' THEN 1 ELSE 0 END) invalid, SUM(CASE WHEN EXISTS (SELECT 1 FROM content_items video WHERE video.type = 'video' AND video.status = 'published' AND video.media_id = plan_steps.media_id) THEN 1 ELSE 0 END) valid_media FROM plan_steps WHERE plan_id = ?").bind(id).first<{ count: number; invalid: number; valid_media: number }>()
        : null;
      if (stepStats?.invalid) return jsonError("调理步骤标题和说明不能为空", 422);
      const problem = publishProblem(item.type, { ...item, mediaId: item.media_id });
      if (problem) return jsonError(problem, 422);
      if (requiresClinicalApproval(item.type, item) && !(await hasCurrentClinicalApproval(DB, item.id, item.version))) {
        return jsonError(clinicalApprovalRequiredMessage, 422);
      }
      if (item.media_id) {
        const asset = await DB.prepare("SELECT status FROM media_assets WHERE id = ?").bind(item.media_id).first<{ status: string }>();
        if (!asset || asset.status !== "ready") return jsonError("关联文件不可用", 422);
      }
      const timestamp = now();
      const needsApproval = requiresClinicalApproval(item.type, item);
      const publishUpdate = needsApproval
        ? DB.prepare("UPDATE content_items SET status = 'published', published_at = ?, updated_at = ? WHERE id = ? AND version = ? AND EXISTS (SELECT 1 FROM clinical_approvals WHERE content_id = ? AND content_version = ?)").bind(timestamp, timestamp, id, item.version, id, item.version)
        : DB.prepare("UPDATE content_items SET status = 'published', published_at = ?, updated_at = ? WHERE id = ? AND version = ?").bind(timestamp, timestamp, id, item.version);
      const statements = [publishUpdate];
      if (body.notify === true && (item.type === "article" || item.type === "video")) {
        statements.push(DB.prepare("INSERT INTO notifications (id, content_id, title, body, published_at) SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM content_items WHERE id = ? AND status = 'published' AND version = ?) ON CONFLICT(content_id) DO UPDATE SET title = excluded.title, body = excluded.body, published_at = excluded.published_at").bind(identifier("notice"), id, item.title, item.summary || "有新内容已发布", timestamp, id, item.version));
      }
      statements.push(DB.prepare("INSERT INTO audit_logs (id, actor, action, entity_type, entity_id, details, created_at) SELECT ?, ?, 'publish', ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM content_items WHERE id = ? AND status = 'published' AND version = ?)").bind(identifier("audit"), session.username, item.type, id, JSON.stringify({ notify: body.notify === true }), timestamp, id, item.version));
      const results = await DB.batch(statements);
      if (results[0].meta.changes === 0) return jsonError("内容已被其他管理员更新，请刷新后重试", 409);
      return Response.json({ id, status: "published" });
    }
    if (action === "offline") {
      if (item.type === "video" && item.media_id) {
        const reference = await DB.prepare("SELECT COUNT(*) count FROM plan_steps step JOIN content_items plan ON plan.id = step.plan_id WHERE step.media_id = ? AND plan.status = 'published'").bind(item.media_id).first<{ count: number }>();
        if (Number(reference?.count ?? 0) > 0) return jsonError("该视频仍被已发布调理方案使用，请先下架相关方案", 409);
      }
      const timestamp = now();
      const results = await DB.batch([
        DB.prepare("UPDATE content_items SET status = 'offline', updated_at = ? WHERE id = ? AND version = ?").bind(timestamp, id, item.version),
        DB.prepare("DELETE FROM notifications WHERE content_id = ? AND EXISTS (SELECT 1 FROM content_items WHERE id = ? AND status = 'offline' AND version = ?)").bind(id, id, item.version),
        DB.prepare("INSERT INTO audit_logs (id, actor, action, entity_type, entity_id, details, created_at) SELECT ?, ?, 'offline', ?, ?, '{}', ? WHERE EXISTS (SELECT 1 FROM content_items WHERE id = ? AND status = 'offline' AND version = ?)").bind(identifier("audit"), session.username, item.type, id, timestamp, id, item.version),
      ]);
      if (results[0].meta.changes === 0) return jsonError("内容已被其他管理员更新，请刷新后重试", 409);
      return Response.json({ id, status: "offline" });
    }
    if (action === "update") {
      const metadata = parseMetadata(body.metadata);
      const timestamp = now();
      const results = await DB.batch([
        DB.prepare("UPDATE content_items SET title = ?, category = ?, summary = ?, body = ?, source = ?, media_id = ?, metadata = ?, status = 'draft', published_at = NULL, updated_at = ?, version = version + 1 WHERE id = ? AND version = ?")
          .bind(cleanText(body.title, 160) || item.title, cleanText(body.category, 80) || item.category, cleanText(body.summary, 1000), cleanText(body.body), cleanText(body.source, 1000), cleanText(body.mediaId, 120) || null, JSON.stringify(metadata), timestamp, id, item.version),
        DB.prepare("DELETE FROM notifications WHERE content_id = ?").bind(id),
        DB.prepare("INSERT INTO audit_logs (id, actor, action, entity_type, entity_id, details, created_at) VALUES (?, ?, 'update', ?, ?, '{}', ?)").bind(identifier("audit"), session.username, item.type, id, timestamp),
      ]);
      if (results[0].meta.changes === 0) return jsonError("内容已被其他管理员更新，请刷新后重试", 409);
      return Response.json({ id, status: "draft" });
    }
    return jsonError("无效操作");
  } catch (error) {
    return adminRouteError(error);
  }
}
