export type ContentType = "article" | "video" | "knowledge" | "plan";
export type ContentStatus = "draft" | "published" | "offline" | "indexing" | "index_failed";

export type RuntimeEnv = {
  DB?: D1Database;
  MEDIA?: R2Bucket;
  VECTORIZE?: VectorizeIndex;
  EMBEDDINGS?: Fetcher;
  CLINICAL_APPROVER_USERS?: string;
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

export async function stableIdentifier(prefix: string, value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  const hex = [...new Uint8Array(digest)].map((item) => item.toString(16).padStart(2, "0")).join("");
  return `${prefix}_${hex.slice(0, 40)}`;
}

export async function stableRequestHash(value: unknown) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value)));
  return [...new Uint8Array(digest)].map((item) => item.toString(16).padStart(2, "0")).join("");
}

export async function hasCurrentClinicalApproval(database: D1Database, contentId: string, version: number) {
  const row = await database.prepare("SELECT content_id FROM clinical_approvals WHERE content_id = ? AND content_version = ?").bind(contentId, version).first<{ content_id: string }>();
  return Boolean(row);
}

export async function audit(actor: string, action: string, entityType: string, entityId: string, details: unknown = {}) {
  const { DB } = await runtime();
  await DB.prepare("INSERT INTO audit_logs (id, actor, action, entity_type, entity_id, details, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(identifier("audit"), actor, action, entityType, entityId, JSON.stringify(details), now()).run();
}

export async function executeIdempotent(actor: string, key: string | null, requestHash: string | null, operation: (lease?: { marker: string }) => Promise<Response>) {
  if (!key) return operation();
  const { DB } = await runtime();
  const staleBefore = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  let existing = await DB.prepare("SELECT response, created_at FROM idempotency_keys WHERE key = ? AND actor = ?").bind(key, actor).first<{ response: string; created_at: string }>();
  if (existing?.response.startsWith("__pending__:") && existing.created_at < staleBefore) {
    await DB.prepare("DELETE FROM idempotency_keys WHERE key = ? AND actor = ? AND response = ? AND created_at < ?").bind(key, actor, existing.response, staleBefore).run();
    existing = await DB.prepare("SELECT response, created_at FROM idempotency_keys WHERE key = ? AND actor = ?").bind(key, actor).first<{ response: string; created_at: string }>();
  }
  if (existing) {
    if (existing.response.startsWith("__pending__:")) return jsonError("相同请求正在处理中", 409);
    const stored = JSON.parse(existing.response) as { body?: unknown; status?: number } | unknown;
    if (stored && typeof stored === "object" && "body" in stored) {
      const replay = stored as { body: unknown; status?: number };
      if (requestHash && (!("requestHash" in stored) || stored.requestHash !== requestHash)) return jsonError("幂等键已用于不同请求，请使用新的幂等键", 409);
      return Response.json(replay.body, { status: replay.status ?? 200 });
    }
    return Response.json(stored);
  }
  const marker = `__pending__:${crypto.randomUUID()}`;
  const claim = await DB.prepare("INSERT OR IGNORE INTO idempotency_keys (key, actor, response, created_at) VALUES (?, ?, ?, ?)").bind(key, actor, marker, now()).run();
  if (claim.meta.changes === 0) return jsonError("相同请求正在处理中", 409);
  try {
    const response = await operation({ marker });
    if (response.ok) {
      const body = await response.clone().json();
      const completed = await DB.prepare("UPDATE idempotency_keys SET response = ? WHERE key = ? AND actor = ? AND response = ?").bind(JSON.stringify({ body, status: response.status, requestHash }), key, actor, marker).run();
      if (completed.meta.changes === 0) throw new Error("IDEMPOTENCY_LEASE_LOST");
    } else {
      await DB.prepare("DELETE FROM idempotency_keys WHERE key = ? AND actor = ? AND response = ?").bind(key, actor, marker).run();
    }
    return response;
  } catch (error) {
    await DB.prepare("DELETE FROM idempotency_keys WHERE key = ? AND actor = ? AND response = ?").bind(key, actor, marker).run();
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
