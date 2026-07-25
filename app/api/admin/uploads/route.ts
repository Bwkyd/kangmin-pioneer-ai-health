import { requireAdmin } from "@/lib/admin/auth";
import { adminRouteError, identifier, jsonError, now, runtime } from "@/lib/admin/store";

const accepted = new Map([
  ["image/jpeg", { kind: "image", maximum: 10 * 1024 * 1024 }],
  ["image/png", { kind: "image", maximum: 10 * 1024 * 1024 }],
  ["image/webp", { kind: "image", maximum: 10 * 1024 * 1024 }],
  ["video/mp4", { kind: "video", maximum: 500 * 1024 * 1024 }],
  ["application/pdf", { kind: "document", maximum: 30 * 1024 * 1024 }],
  ["text/plain", { kind: "document", maximum: 5 * 1024 * 1024 }],
  ["text/markdown", { kind: "document", maximum: 5 * 1024 * 1024 }],
]);

function safeFilename(value: string) {
  return value.normalize("NFKC").replace(/[^\p{L}\p{N}._-]+/gu, "-").slice(0, 120) || "upload";
}

export async function POST(request: Request) {
  try {
    const session = await requireAdmin();
    const values = await runtime();
    if (!values.MEDIA) return jsonError("文件存储尚未配置", 503);
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) return jsonError("请选择文件");
    const rule = accepted.get(file.type);
    if (!rule) return jsonError("不支持该文件类型", 415);
    if (file.size <= 0 || file.size > rule.maximum) return jsonError("文件为空或超过大小限制", 413);
    const id = identifier("media");
    const filename = safeFilename(file.name);
    const objectKey = `${rule.kind}/${new Date().toISOString().slice(0, 10)}/${id}-${filename}`;
    await values.MEDIA.put(objectKey, file.stream(), { httpMetadata: { contentType: file.type }, customMetadata: { originalName: filename } });
    try {
      const timestamp = now();
      await values.DB.batch([
        values.DB.prepare("INSERT INTO media_assets (id, kind, filename, object_key, content_type, byte_size, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'ready', ?, ?)")
          .bind(id, rule.kind, filename, objectKey, file.type, file.size, timestamp, timestamp),
        values.DB.prepare("INSERT INTO audit_logs (id, actor, action, entity_type, entity_id, details, created_at) VALUES (?, ?, 'upload', 'media', ?, ?, ?)").bind(identifier("audit"), session.username, id, JSON.stringify({ filename, byteSize: file.size }), timestamp),
      ]);
    } catch (error) {
      await values.MEDIA.delete(objectKey);
      throw error;
    }
    return Response.json({ id, filename, kind: rule.kind, byteSize: file.size }, { status: 201 });
  } catch (error) {
    if (error instanceof Error && error.message === "ADMIN_UNAUTHORIZED") return jsonError("未授权", 401);
    return jsonError("文件上传失败", 500);
  }
}

export async function GET() {
  try {
    await requireAdmin();
    const rows = await (await runtime()).DB.prepare("SELECT id, kind, filename, content_type contentType, byte_size byteSize, status, created_at createdAt FROM media_assets ORDER BY created_at DESC").all();
    return Response.json({ items: rows.results });
  } catch (error) { return adminRouteError(error); }
}
