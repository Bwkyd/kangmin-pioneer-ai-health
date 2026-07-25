export type ContentType = "article" | "video" | "knowledge" | "plan";
export type ContentStatus = "draft" | "published" | "offline" | "indexing" | "index_failed";

export type RuntimeEnv = {
  DB?: D1Database;
  MEDIA?: R2Bucket;
  VECTORIZE?: VectorizeIndex;
  EMBEDDINGS?: Fetcher;
};

export async function runtime() {
  const { env } = await import("cloudflare:workers");
  const values = env as unknown as RuntimeEnv;
  if (!values.DB) throw new Error("DATABASE_NOT_CONFIGURED");
  await ensureAdminSchema(values.DB);
  return values as RuntimeEnv & { DB: D1Database };
}

const schemaReady = new WeakMap<object, Promise<unknown>>();

function ensureAdminSchema(database: D1Database) {
  const cached = schemaReady.get(database);
  if (cached) return cached;
  const initialization = database.batch(adminSchemaStatements.map((statement) => database.prepare(statement)));
  schemaReady.set(database, initialization);
  initialization.catch(() => schemaReady.delete(database));
  return initialization;
}

export function now() {
  return new Date().toISOString();
}

export function identifier(prefix: string) {
  return `${prefix}_${crypto.randomUUID()}`;
}

export async function audit(actor: string, action: string, entityType: string, entityId: string, details: unknown = {}) {
  const { DB } = await runtime();
  await DB.prepare("INSERT INTO audit_logs (id, actor, action, entity_type, entity_id, details, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(identifier("audit"), actor, action, entityType, entityId, JSON.stringify(details), now()).run();
}

export async function executeIdempotent(actor: string, key: string | null, operation: () => Promise<Response>) {
  if (!key) return operation();
  const { DB } = await runtime();
  const existing = await DB.prepare("SELECT response FROM idempotency_keys WHERE key = ? AND actor = ?").bind(key, actor).first<{ response: string }>();
  if (existing) {
    if (existing.response === "__pending__") return jsonError("相同请求正在处理中", 409);
    const stored = JSON.parse(existing.response) as { body?: unknown; status?: number } | unknown;
    if (stored && typeof stored === "object" && "body" in stored) {
      const replay = stored as { body: unknown; status?: number };
      return Response.json(replay.body, { status: replay.status ?? 200 });
    }
    return Response.json(stored);
  }
  const claim = await DB.prepare("INSERT OR IGNORE INTO idempotency_keys (key, actor, response, created_at) VALUES (?, ?, '__pending__', ?)").bind(key, actor, now()).run();
  if (claim.meta.changes === 0) return jsonError("相同请求正在处理中", 409);
  try {
    const response = await operation();
    if (response.ok) {
      const body = await response.clone().json();
      await DB.prepare("UPDATE idempotency_keys SET response = ? WHERE key = ? AND actor = ?").bind(JSON.stringify({ body, status: response.status }), key, actor).run();
    } else {
      await DB.prepare("DELETE FROM idempotency_keys WHERE key = ? AND actor = ?").bind(key, actor).run();
    }
    return response;
  } catch (error) {
    await DB.prepare("DELETE FROM idempotency_keys WHERE key = ? AND actor = ?").bind(key, actor).run();
    throw error;
  }
}

export function jsonError(message: string, status = 400) {
  return Response.json({ error: message }, { status });
}

export function adminRouteError(error: unknown, message = "管理服务暂不可用") {
  if (error instanceof Error && error.message === "ADMIN_UNAUTHORIZED") return jsonError("未授权", 401);
  return jsonError(message, 503);
}
import { adminSchemaStatements } from "./schema-sql";
