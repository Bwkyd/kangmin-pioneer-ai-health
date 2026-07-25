import { requireAdmin } from "@/lib/admin/auth";
import { adminRouteError, executeIdempotent, identifier, jsonError, now, runtime, type ContentStatus, type ContentType } from "@/lib/admin/store";
import { cleanText, contentTypes, parseMetadata, publishProblem } from "@/lib/admin/validation";

type ContentRow = { id: string; type: ContentType; title: string; category: string; summary: string; body: string; source: string; status: ContentStatus; version: number; media_id: string | null; metadata: string; published_at: string | null; created_at: string; updated_at: string };

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
    return executeIdempotent(session.username, request.headers.get("Idempotency-Key"), async () => {
      const id = identifier(type);
      const timestamp = now();
      const metadata = parseMetadata(body.metadata);
      const { DB } = await runtime();
      await DB.batch([
        DB.prepare("INSERT INTO content_items (id, type, title, category, summary, body, source, status, version, media_id, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', 1, ?, ?, ?, ?)")
          .bind(id, type, title, cleanText(body.category, 80) || "未分类", cleanText(body.summary, 1000), cleanText(body.body), cleanText(body.source, 1000), cleanText(body.mediaId, 120) || null, JSON.stringify(metadata), timestamp, timestamp),
        DB.prepare("INSERT INTO audit_logs (id, actor, action, entity_type, entity_id, details, created_at) VALUES (?, ?, 'create', ?, ?, '{}', ?)").bind(identifier("audit"), session.username, type, id, timestamp),
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
    if (action === "publish") {
      const stepStats = item.type === "plan"
        ? await DB.prepare("SELECT COUNT(*) count, SUM(CASE WHEN title = '' OR instruction = '' THEN 1 ELSE 0 END) invalid, SUM(CASE WHEN EXISTS (SELECT 1 FROM content_items video WHERE video.type = 'video' AND video.status = 'published' AND video.media_id = plan_steps.media_id) THEN 1 ELSE 0 END) valid_media FROM plan_steps WHERE plan_id = ?").bind(id).first<{ count: number; invalid: number; valid_media: number }>()
        : null;
      if (stepStats?.invalid) return jsonError("调理步骤标题和说明不能为空", 422);
      const problem = publishProblem(item.type, { ...item, mediaId: item.media_id }, Number(stepStats?.count ?? 0), Number(stepStats?.valid_media ?? 0));
      if (problem) return jsonError(problem, 422);
      if (item.media_id) {
        const asset = await DB.prepare("SELECT status FROM media_assets WHERE id = ?").bind(item.media_id).first<{ status: string }>();
        if (!asset || asset.status !== "ready") return jsonError("关联文件不可用", 422);
      }
      const timestamp = now();
      const statements = [DB.prepare("UPDATE content_items SET status = 'published', published_at = ?, updated_at = ? WHERE id = ?").bind(timestamp, timestamp, id)];
      if (body.notify === true && (item.type === "article" || item.type === "video")) {
        statements.push(DB.prepare("INSERT INTO notifications (id, content_id, title, body, published_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(content_id) DO UPDATE SET title = excluded.title, body = excluded.body, published_at = excluded.published_at").bind(identifier("notice"), id, item.title, item.summary || "有新内容已发布", timestamp));
      }
      statements.push(DB.prepare("INSERT INTO audit_logs (id, actor, action, entity_type, entity_id, details, created_at) VALUES (?, ?, 'publish', ?, ?, ?, ?)").bind(identifier("audit"), session.username, item.type, id, JSON.stringify({ notify: body.notify === true }), timestamp));
      await DB.batch(statements);
      return Response.json({ id, status: "published" });
    }
    if (action === "offline") {
      if (item.type === "video" && item.media_id) {
        const reference = await DB.prepare("SELECT COUNT(*) count FROM plan_steps step JOIN content_items plan ON plan.id = step.plan_id WHERE step.media_id = ? AND plan.status = 'published'").bind(item.media_id).first<{ count: number }>();
        if (Number(reference?.count ?? 0) > 0) return jsonError("该视频仍被已发布调理方案使用，请先下架相关方案", 409);
      }
      const timestamp = now();
      await DB.batch([
        DB.prepare("UPDATE content_items SET status = 'offline', updated_at = ? WHERE id = ?").bind(timestamp, id),
        DB.prepare("DELETE FROM notifications WHERE content_id = ?").bind(id),
        DB.prepare("INSERT INTO audit_logs (id, actor, action, entity_type, entity_id, details, created_at) VALUES (?, ?, 'offline', ?, ?, '{}', ?)").bind(identifier("audit"), session.username, item.type, id, timestamp),
      ]);
      return Response.json({ id, status: "offline" });
    }
    if (action === "update") {
      const metadata = parseMetadata(body.metadata);
      const timestamp = now();
      await DB.batch([
        DB.prepare("UPDATE content_items SET title = ?, category = ?, summary = ?, body = ?, source = ?, media_id = ?, metadata = ?, status = 'draft', published_at = NULL, updated_at = ?, version = version + 1 WHERE id = ?")
          .bind(cleanText(body.title, 160) || item.title, cleanText(body.category, 80) || item.category, cleanText(body.summary, 1000), cleanText(body.body), cleanText(body.source, 1000), cleanText(body.mediaId, 120) || null, JSON.stringify(metadata), timestamp, id),
        DB.prepare("DELETE FROM notifications WHERE content_id = ?").bind(id),
        DB.prepare("INSERT INTO audit_logs (id, actor, action, entity_type, entity_id, details, created_at) VALUES (?, ?, 'update', ?, ?, '{}', ?)").bind(identifier("audit"), session.username, item.type, id, timestamp),
      ]);
      return Response.json({ id, status: "draft" });
    }
    return jsonError("无效操作");
  } catch (error) {
    return adminRouteError(error);
  }
}
